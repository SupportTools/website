---
title: "AWS EKS Production Deployment: Managed Node Groups, IRSA, and Cost Optimization"
date: 2027-08-04T00:00:00-05:00
draft: false
tags: ["AWS", "EKS", "Kubernetes", "Cloud", "Production"]
categories:
- AWS
- Kubernetes
- Cloud
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to deploying production-grade Amazon EKS clusters covering managed node groups, IAM Roles for Service Accounts, VPC CNI with prefix delegation, cluster autoscaler, spot instance strategies, and cost optimization techniques."
more_link: "yes"
url: "/aws-eks-production-deployment-guide/"
---

Running Kubernetes workloads on Amazon EKS requires more than provisioning a cluster and deploying pods. Production environments demand careful attention to networking architecture, IAM integration, node group strategies, observability pipelines, and upgrade procedures. This guide walks through every major decision point for EKS in production, from VPC CNI tuning and IRSA configuration to spot instance node groups and CloudWatch log routing.

<!--more-->

# [AWS EKS Production Deployment](#aws-eks-production-deployment)

## Section 1: EKS Cluster Architecture

### Control Plane Overview

Amazon EKS manages the Kubernetes control plane as a fully managed service. The API server, etcd, controller manager, and scheduler run in AWS-managed infrastructure with multi-AZ redundancy. The managed control plane removes the operational burden of patching and scaling control plane components, but cluster operators remain responsible for data plane configuration, networking, IAM, and add-on management.

Every EKS cluster gets a unique API endpoint backed by an AWS-managed Elastic Load Balancer. The endpoint can be configured as public, private, or both. Production clusters should restrict public endpoint access using CIDR allow-lists or disable public access entirely and rely on a VPN or AWS Direct Connect for cluster API access.

```yaml
# eksctl cluster configuration - control plane networking
apiVersion: eksctl.io/v1alpha5
kind: ClusterConfig

metadata:
  name: prod-cluster
  region: us-east-1
  version: "1.30"

vpc:
  clusterEndpoints:
    publicAccess: true
    privateAccess: true
  publicAccessCIDRs:
    - "10.0.0.0/8"
    - "203.0.113.0/24"

kubernetesNetworkConfig:
  serviceIPv4CIDR: "172.20.0.0/16"
  ipFamily: IPv4
```

### VPC Design for EKS

The VPC layout directly affects pod density, cross-AZ traffic costs, and network policy enforcement. The recommended design for production EKS clusters uses separate subnets for nodes, pods, and load balancers.

With VPC CNI prefix delegation enabled, each node can host many more pods by assigning /28 IPv4 prefixes to ENIs rather than individual secondary IPs. This reduces the IP consumption overhead significantly.

```
VPC: 10.0.0.0/16

Public subnets (load balancers, NAT gateways):
  us-east-1a: 10.0.0.0/24
  us-east-1b: 10.0.1.0/24
  us-east-1c: 10.0.2.0/24

Private subnets (nodes):
  us-east-1a: 10.0.10.0/22
  us-east-1b: 10.0.14.0/22
  us-east-1c: 10.0.18.0/22

Pod subnets (secondary CIDR for VPC CNI custom networking):
  us-east-1a: 100.64.0.0/18
  us-east-1b: 100.64.64.0/18
  us-east-1c: 100.64.128.0/18
```

Tag public subnets with `kubernetes.io/role/elb: "1"` and private subnets with `kubernetes.io/role/internal-elb: "1"` so the AWS Load Balancer Controller can discover the correct subnets automatically.

```bash
# Tag subnets for load balancer discovery
aws ec2 create-tags \
  --resources subnet-PUBLIC1 subnet-PUBLIC2 subnet-PUBLIC3 \
  --tags Key=kubernetes.io/role/elb,Value=1 \
         Key=kubernetes.io/cluster/prod-cluster,Value=shared

aws ec2 create-tags \
  --resources subnet-PRIVATE1 subnet-PRIVATE2 subnet-PRIVATE3 \
  --tags Key=kubernetes.io/role/internal-elb,Value=1 \
         Key=kubernetes.io/cluster/prod-cluster,Value=shared
```

## Section 2: Managed Node Groups vs Fargate

### Managed Node Groups

Managed node groups automate the provisioning and lifecycle of EC2 instances. AWS handles node patching, AMI updates, and cordon/drain procedures during upgrades. Each managed node group uses an Auto Scaling Group under the hood, which integrates with the cluster autoscaler and Karpenter.

```yaml
# eksctl managed node group definition
managedNodeGroups:
  - name: system-ng
    instanceType: m6i.xlarge
    minSize: 3
    desiredCapacity: 3
    maxSize: 6
    availabilityZones:
      - us-east-1a
      - us-east-1b
      - us-east-1c
    volumeSize: 100
    volumeType: gp3
    amiFamily: AmazonLinux2023
    labels:
      role: system
      node-type: managed
    taints:
      - key: CriticalAddonsOnly
        value: "true"
        effect: NoSchedule
    tags:
      nodegroup-role: system
    iam:
      withAddonPolicies:
        imageBuilder: false
        autoScaler: true
        externalDNS: true
        certManager: true
        efs: true
        ebs: true
        albIngress: true
        cloudWatch: true

  - name: app-ng-ondemand
    instanceTypes:
      - m6i.2xlarge
      - m6a.2xlarge
      - m5.2xlarge
    minSize: 3
    desiredCapacity: 6
    maxSize: 30
    availabilityZones:
      - us-east-1a
      - us-east-1b
      - us-east-1c
    volumeSize: 100
    volumeType: gp3
    labels:
      role: application
      node-type: on-demand
    tags:
      nodegroup-role: application

  - name: app-ng-spot
    instanceTypes:
      - m6i.2xlarge
      - m6a.2xlarge
      - m5.2xlarge
      - m5a.2xlarge
      - m4.2xlarge
    spot: true
    minSize: 0
    desiredCapacity: 3
    maxSize: 60
    availabilityZones:
      - us-east-1a
      - us-east-1b
      - us-east-1c
    volumeSize: 100
    volumeType: gp3
    labels:
      role: application
      node-type: spot
      eks.amazonaws.com/capacityType: SPOT
    taints:
      - key: spot
        value: "true"
        effect: PreferNoSchedule
```

### Spot Instance Node Groups

Spot instances offer up to 90% cost savings compared to on-demand pricing but are subject to interruption with a two-minute warning. A robust spot strategy involves diversifying across multiple instance families and sizes, handling interruption notices gracefully, and running stateless workloads that tolerate occasional eviction.

The node termination handler (aws-node-termination-handler) watches for spot interruption notices via the EC2 instance metadata service and cordons and drains nodes before the instance is reclaimed.

```bash
# Install aws-node-termination-handler with Helm
helm repo add eks https://aws.github.io/eks-charts
helm repo update

helm install aws-node-termination-handler \
  eks/aws-node-termination-handler \
  --namespace kube-system \
  --set enableSpotInterruptionDraining=true \
  --set enableScheduledEventDraining=true \
  --set enableRebalanceMonitoring=true \
  --set enableRebalanceDraining=false \
  --set nodeSelector."eks\\.amazonaws\\.com/capacityType"=SPOT \
  --set podTerminationGracePeriod=120 \
  --set nodeTerminationGracePeriod=120
```

For workloads that should run on spot nodes, configure pod affinity and toleration:

```yaml
spec:
  tolerations:
    - key: spot
      operator: Equal
      value: "true"
      effect: PreferNoSchedule
  affinity:
    nodeAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 80
          preference:
            matchExpressions:
              - key: eks.amazonaws.com/capacityType
                operator: In
                values:
                  - SPOT
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
          - matchExpressions:
              - key: role
                operator: In
                values:
                  - application
```

### Fargate Profiles

AWS Fargate eliminates node management entirely by running each pod on its own isolated microVM. Fargate is suitable for batch workloads, developer environments, and workloads with highly variable resource usage. Fargate pods cannot use DaemonSets, HostNetwork, or privileged containers.

```yaml
fargateProfiles:
  - name: batch-jobs
    selectors:
      - namespace: batch
        labels:
          workload-type: batch
      - namespace: default
        labels:
          fargate: "true"
    subnets:
      - subnet-PRIVATE1
      - subnet-PRIVATE2
      - subnet-PRIVATE3
```

## Section 3: IAM Roles for Service Accounts (IRSA)

### How IRSA Works

IRSA allows Kubernetes service accounts to assume IAM roles without distributing long-lived credentials. The mechanism relies on the EKS OIDC provider. When a pod references a service account annotated with an IAM role ARN, the pod webhook injects an environment variable pointing to a projected service account token. The AWS SDK exchanges this token with STS to obtain temporary credentials scoped to the annotated role.

### Setting Up IRSA

```bash
# Enable OIDC provider for the cluster
eksctl utils associate-iam-oidc-provider \
  --cluster prod-cluster \
  --region us-east-1 \
  --approve

# Get the OIDC provider URL
OIDC_URL=$(aws eks describe-cluster \
  --name prod-cluster \
  --query "cluster.identity.oidc.issuer" \
  --output text)

echo "OIDC URL: ${OIDC_URL}"
```

### Creating an IRSA Role with eksctl

```bash
# Create an IAM service account for external-dns
eksctl create iamserviceaccount \
  --cluster prod-cluster \
  --namespace kube-system \
  --name external-dns \
  --attach-policy-arn arn:aws:iam::aws:policy/AmazonRoute53FullAccess \
  --approve \
  --override-existing-serviceaccounts
```

### Manually Creating IRSA Trust Policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::ACCOUNT_ID:oidc-provider/oidc.eks.us-east-1.amazonaws.com/id/OIDC_ID"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "oidc.eks.us-east-1.amazonaws.com/id/OIDC_ID:sub": "system:serviceaccount:kube-system:aws-load-balancer-controller",
          "oidc.eks.us-east-1.amazonaws.com/id/OIDC_ID:aud": "sts.amazonaws.com"
        }
      }
    }
  ]
}
```

### Annotating Service Accounts

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: aws-load-balancer-controller
  namespace: kube-system
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::ACCOUNT_ID:role/AWSLoadBalancerControllerRole
    eks.amazonaws.com/sts-regional-endpoints: "true"
    eks.amazonaws.com/token-expiration: "86400"
```

### IRSA for Application Workloads

```yaml
# S3 read access for application pods
apiVersion: v1
kind: ServiceAccount
metadata:
  name: app-s3-reader
  namespace: production
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::ACCOUNT_ID:role/AppS3ReaderRole
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: production
spec:
  template:
    spec:
      serviceAccountName: app-s3-reader
      containers:
        - name: app
          image: my-app:latest
          env:
            - name: AWS_REGION
              value: us-east-1
```

The IAM role policy for the application:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:ListBucket",
        "s3:GetBucketLocation"
      ],
      "Resource": [
        "arn:aws:s3:::my-app-bucket",
        "arn:aws:s3:::my-app-bucket/*"
      ]
    }
  ]
}
```

## Section 4: EKS Add-ons

### VPC CNI Add-on

The Amazon VPC CNI plugin assigns VPC IP addresses directly to pods. Each pod gets an IP from the VPC subnet, enabling seamless communication with other VPC resources without NAT.

```bash
# Install or update the VPC CNI add-on
aws eks create-addon \
  --cluster-name prod-cluster \
  --addon-name vpc-cni \
  --addon-version v1.18.0-eksbuild.1 \
  --service-account-role-arn arn:aws:iam::ACCOUNT_ID:role/AmazonEKSVPCCNIRole \
  --configuration-values '{"env":{"ENABLE_PREFIX_DELEGATION":"true","WARM_PREFIX_TARGET":"1"}}'

# Check add-on status
aws eks describe-addon \
  --cluster-name prod-cluster \
  --addon-name vpc-cni \
  --query "addon.status"
```

### Enabling Prefix Delegation

Prefix delegation assigns /28 prefixes to ENIs, dramatically increasing pod density per node. A c5.xlarge with prefix delegation can run up to 110 pods instead of the default 58.

```bash
# Enable prefix delegation on existing cluster
kubectl set env daemonset aws-node \
  -n kube-system \
  ENABLE_PREFIX_DELEGATION=true \
  WARM_PREFIX_TARGET=1 \
  MINIMUM_IP_TARGET=5
```

### CoreDNS Add-on

```bash
# Update CoreDNS add-on
aws eks create-addon \
  --cluster-name prod-cluster \
  --addon-name coredns \
  --addon-version v1.11.1-eksbuild.4 \
  --resolve-conflicts OVERWRITE

# Scale CoreDNS for high traffic clusters
kubectl scale deployment coredns \
  -n kube-system \
  --replicas=4
```

### kube-proxy Add-on

```bash
# Update kube-proxy add-on
aws eks create-addon \
  --cluster-name prod-cluster \
  --addon-name kube-proxy \
  --addon-version v1.30.0-eksbuild.3 \
  --resolve-conflicts OVERWRITE
```

### EBS CSI Driver Add-on

```bash
# Create IAM role for EBS CSI driver
eksctl create iamserviceaccount \
  --cluster prod-cluster \
  --namespace kube-system \
  --name ebs-csi-controller-sa \
  --attach-policy-arn arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy \
  --approve

# Install EBS CSI driver add-on
aws eks create-addon \
  --cluster-name prod-cluster \
  --addon-name aws-ebs-csi-driver \
  --service-account-role-arn arn:aws:iam::ACCOUNT_ID:role/AmazonEKS_EBS_CSI_DriverRole
```

StorageClass configuration for EBS gp3 volumes:

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: ebs.csi.aws.com
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
parameters:
  type: gp3
  iops: "3000"
  throughput: "125"
  encrypted: "true"
  kmsKeyId: arn:aws:kms:us-east-1:ACCOUNT_ID:key/KEY_ID
```

## Section 5: AWS Load Balancer Controller

### Installation

The AWS Load Balancer Controller provisions ALBs for Ingress resources and NLBs for LoadBalancer Services. It replaces the legacy in-tree AWS cloud provider for load balancer provisioning.

```bash
# Create IAM policy for the controller
curl -O https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/main/docs/install/iam_policy.json

aws iam create-policy \
  --policy-name AWSLoadBalancerControllerIAMPolicy \
  --policy-document file://iam_policy.json

# Create IRSA service account
eksctl create iamserviceaccount \
  --cluster prod-cluster \
  --namespace kube-system \
  --name aws-load-balancer-controller \
  --attach-policy-arn arn:aws:iam::ACCOUNT_ID:policy/AWSLoadBalancerControllerIAMPolicy \
  --override-existing-serviceaccounts \
  --approve

# Install the controller
helm repo add eks https://aws.github.io/eks-charts
helm repo update

helm install aws-load-balancer-controller \
  eks/aws-load-balancer-controller \
  -n kube-system \
  --set clusterName=prod-cluster \
  --set serviceAccount.create=false \
  --set serviceAccount.name=aws-load-balancer-controller \
  --set region=us-east-1 \
  --set vpcId=vpc-XXXXXXXX \
  --set replicaCount=2
```

### Ingress with ALB

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-app-ingress
  namespace: production
  annotations:
    kubernetes.io/ingress.class: alb
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTP": 80}, {"HTTPS": 443}]'
    alb.ingress.kubernetes.io/ssl-redirect: "443"
    alb.ingress.kubernetes.io/certificate-arn: arn:aws:acm:us-east-1:ACCOUNT_ID:certificate/CERT_ID
    alb.ingress.kubernetes.io/healthcheck-path: /healthz
    alb.ingress.kubernetes.io/healthcheck-interval-seconds: "30"
    alb.ingress.kubernetes.io/healthy-threshold-count: "2"
    alb.ingress.kubernetes.io/unhealthy-threshold-count: "3"
    alb.ingress.kubernetes.io/load-balancer-attributes: |
      idle_timeout.timeout_seconds=60,
      routing.http2.enabled=true,
      access_logs.s3.enabled=true,
      access_logs.s3.bucket=my-alb-logs,
      access_logs.s3.prefix=prod-cluster
    alb.ingress.kubernetes.io/wafv2-acl-arn: arn:aws:wafv2:us-east-1:ACCOUNT_ID:regional/webacl/prod-waf/WAF_ID
spec:
  rules:
    - host: api.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: api-service
                port:
                  number: 8080
```

### NLB for Internal Services

```yaml
apiVersion: v1
kind: Service
metadata:
  name: internal-api
  namespace: production
  annotations:
    service.beta.kubernetes.io/aws-load-balancer-type: external
    service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: ip
    service.beta.kubernetes.io/aws-load-balancer-scheme: internal
    service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled: "true"
    service.beta.kubernetes.io/aws-load-balancer-proxy-protocol: "*"
spec:
  type: LoadBalancer
  selector:
    app: internal-api
  ports:
    - port: 443
      targetPort: 8443
      protocol: TCP
```

## Section 6: Cluster Autoscaler on EKS

### Installation and Configuration

```bash
# Create IAM policy for cluster autoscaler
cat > cluster-autoscaler-policy.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "autoscaling:DescribeAutoScalingGroups",
        "autoscaling:DescribeAutoScalingInstances",
        "autoscaling:DescribeLaunchConfigurations",
        "autoscaling:DescribeScalingActivities",
        "autoscaling:DescribeTags",
        "ec2:DescribeImages",
        "ec2:DescribeInstanceTypes",
        "ec2:DescribeLaunchTemplateVersions",
        "ec2:GetInstanceTypesFromInstanceRequirements",
        "eks:DescribeNodegroup"
      ],
      "Resource": ["*"]
    },
    {
      "Effect": "Allow",
      "Action": [
        "autoscaling:SetDesiredCapacity",
        "autoscaling:TerminateInstanceInAutoScalingGroup"
      ],
      "Resource": ["*"]
    }
  ]
}
EOF

aws iam create-policy \
  --policy-name ClusterAutoscalerPolicy \
  --policy-document file://cluster-autoscaler-policy.json

eksctl create iamserviceaccount \
  --cluster prod-cluster \
  --namespace kube-system \
  --name cluster-autoscaler \
  --attach-policy-arn arn:aws:iam::ACCOUNT_ID:policy/ClusterAutoscalerPolicy \
  --approve
```

```yaml
# cluster-autoscaler deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cluster-autoscaler
  namespace: kube-system
  labels:
    app: cluster-autoscaler
spec:
  replicas: 1
  selector:
    matchLabels:
      app: cluster-autoscaler
  template:
    metadata:
      labels:
        app: cluster-autoscaler
      annotations:
        cluster-autoscaler.kubernetes.io/safe-to-evict: "false"
    spec:
      serviceAccountName: cluster-autoscaler
      priorityClassName: system-cluster-critical
      tolerations:
        - key: CriticalAddonsOnly
          operator: Exists
      nodeSelector:
        role: system
      containers:
        - name: cluster-autoscaler
          image: registry.k8s.io/autoscaling/cluster-autoscaler:v1.30.0
          command:
            - ./cluster-autoscaler
            - --v=4
            - --stderrthreshold=info
            - --cloud-provider=aws
            - --skip-nodes-with-local-storage=false
            - --expander=least-waste
            - --node-group-auto-discovery=asg:tag=k8s.io/cluster-autoscaler/enabled,k8s.io/cluster-autoscaler/prod-cluster
            - --balance-similar-node-groups
            - --skip-nodes-with-system-pods=false
            - --scale-down-delay-after-add=5m
            - --scale-down-unneeded-time=10m
            - --scale-down-utilization-threshold=0.5
            - --max-graceful-termination-sec=600
          env:
            - name: AWS_REGION
              value: us-east-1
          resources:
            requests:
              cpu: 100m
              memory: 300Mi
            limits:
              cpu: 500m
              memory: 600Mi
```

## Section 7: EKS Logging to CloudWatch

### Control Plane Log Types

EKS supports five control plane log types: api, audit, authenticator, controllerManager, and scheduler. Each log type should be enabled for production clusters for security and troubleshooting.

```bash
# Enable all control plane log types
aws eks update-cluster-config \
  --name prod-cluster \
  --region us-east-1 \
  --logging '{"clusterLogging":[{"types":["api","audit","authenticator","controllerManager","scheduler"],"enabled":true}]}'
```

### Container Insights with Fluent Bit

```bash
# Create the namespace
kubectl create namespace amazon-cloudwatch

# Create the ConfigMap for Fluent Bit
kubectl create configmap fluent-bit-cluster-info \
  --from-literal=cluster.name=prod-cluster \
  --from-literal=http.server=On \
  --from-literal=http.port=2020 \
  --from-literal=read.head=Off \
  --from-literal=read.tail=On \
  --from-literal=logs.region=us-east-1 \
  -n amazon-cloudwatch

# Install CloudWatch agent and Fluent Bit
kubectl apply -f https://raw.githubusercontent.com/aws-samples/amazon-cloudwatch-container-insights/latest/k8s-deployment-manifest-templates/deployment-mode/daemonset/container-insights-monitoring/quickstart/cwagent-fluent-bit-quickstart.yaml
```

### Custom Fluent Bit Configuration

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: fluent-bit-config
  namespace: amazon-cloudwatch
data:
  fluent-bit.conf: |
    [SERVICE]
        Flush                     5
        Grace                     30
        Log_Level                 info
        Daemon                    off
        Parsers_File              parsers.conf
        HTTP_Server               On
        HTTP_Listen               0.0.0.0
        HTTP_Port                 2020
        storage.path              /var/fluent-bit/state/flb-storage/
        storage.sync              normal
        storage.checksum          off
        storage.backlog.mem_limit 5M

    @INCLUDE application-log.conf
    @INCLUDE dataplane-log.conf
    @INCLUDE host-log.conf

  application-log.conf: |
    [INPUT]
        Name                tail
        Tag                 application.*
        Exclude_Path        /var/log/containers/cloudwatch-agent*,/var/log/containers/fluent-bit*
        Path                /var/log/containers/*.log
        multiline.parser    docker, cri
        DB                  /var/fluent-bit/state/flb_container.db
        Mem_Buf_Limit       50MB
        Skip_Long_Lines     On
        Refresh_Interval    10

    [FILTER]
        Name                kubernetes
        Match               application.*
        Kube_URL            https://kubernetes.default.svc:443
        Kube_Tag_Prefix     application.var.log.containers.
        Merge_Log           On
        Merge_Log_Key       log_processed
        K8S-Logging.Parser  On
        K8S-Logging.Exclude Off
        Labels              On
        Annotations         Off
        Buffer_Size         0

    [OUTPUT]
        Name                cloudwatch_logs
        Match               application.*
        region              us-east-1
        log_group_name      /aws/containerinsights/prod-cluster/application
        log_stream_prefix   ${HOST_NAME}-
        auto_create_group   true
        extra_user_agent    container-insights
```

## Section 8: Upgrading EKS Clusters

### Upgrade Strategy

EKS cluster upgrades must follow a specific sequence: control plane first, then add-ons, then node groups. Skipping more than one minor version is not supported. Always test upgrades in a staging cluster before applying to production.

```bash
# Step 1: Check available Kubernetes versions
aws eks describe-addon-versions \
  --kubernetes-version 1.30 \
  --query "addons[].addonName" \
  --output table

# Step 2: Update control plane
aws eks update-cluster-version \
  --name prod-cluster \
  --kubernetes-version 1.31

# Monitor upgrade progress
aws eks describe-cluster \
  --name prod-cluster \
  --query "cluster.status"

# Wait for upgrade to complete (typically 10-20 minutes)
aws eks wait cluster-active \
  --name prod-cluster
```

### Updating Add-ons After Control Plane Upgrade

```bash
# List current add-on versions
aws eks list-addons --cluster-name prod-cluster

# Update VPC CNI
aws eks update-addon \
  --cluster-name prod-cluster \
  --addon-name vpc-cni \
  --addon-version v1.18.0-eksbuild.1 \
  --resolve-conflicts OVERWRITE

# Update CoreDNS
aws eks update-addon \
  --cluster-name prod-cluster \
  --addon-name coredns \
  --addon-version v1.11.1-eksbuild.4 \
  --resolve-conflicts OVERWRITE

# Update kube-proxy
aws eks update-addon \
  --cluster-name prod-cluster \
  --addon-name kube-proxy \
  --addon-version v1.31.0-eksbuild.2 \
  --resolve-conflicts OVERWRITE
```

### Upgrading Node Groups

```bash
# Update managed node group (rolling update)
aws eks update-nodegroup-version \
  --cluster-name prod-cluster \
  --nodegroup-name app-ng-ondemand \
  --release-version latest

# Monitor node group update
aws eks describe-nodegroup \
  --cluster-name prod-cluster \
  --nodegroup-name app-ng-ondemand \
  --query "nodegroup.status"
```

For node groups using custom launch templates, update the launch template version and then trigger a node group update:

```bash
# Create new launch template version with updated AMI
aws ec2 create-launch-template-version \
  --launch-template-id lt-XXXXXXXX \
  --version-description "k8s-1.31" \
  --source-version 1 \
  --launch-template-data '{"ImageId":"ami-NEW_AMI_ID"}'

# Update node group to use new launch template version
aws eks update-nodegroup-version \
  --cluster-name prod-cluster \
  --nodegroup-name app-ng-ondemand \
  --launch-template '{"id":"lt-XXXXXXXX","version":"2"}'
```

## Section 9: Cost Optimization

### Compute Savings Plans and Reserved Instances

EKS node costs can be reduced significantly using Savings Plans or Reserved Instances for baseline capacity, combined with spot instances for burst capacity.

```
Recommended capacity strategy:
- 30-40% of nodes: Compute Savings Plan (1-year, no upfront)
- 20-30% of nodes: On-Demand Reserved Instances (1-year, partial upfront)
- 30-50% of nodes: Spot Instances (2-4 instance families, multiple sizes)
```

### Karpenter for Efficient Node Provisioning

Karpenter replaces the cluster autoscaler with a more efficient just-in-time provisioner that selects the optimal instance type based on pending pod requirements.

```yaml
# Karpenter NodePool for application workloads
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: application
spec:
  template:
    metadata:
      labels:
        role: application
    spec:
      nodeClassRef:
        apiVersion: karpenter.k8s.aws/v1
        kind: EC2NodeClass
        name: application
      requirements:
        - key: kubernetes.io/arch
          operator: In
          values: ["amd64"]
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot", "on-demand"]
        - key: karpenter.k8s.aws/instance-category
          operator: In
          values: ["c", "m", "r"]
        - key: karpenter.k8s.aws/instance-generation
          operator: Gt
          values: ["4"]
        - key: karpenter.k8s.aws/instance-size
          operator: In
          values: ["xlarge", "2xlarge", "4xlarge"]
      expireAfter: 720h
  limits:
    cpu: 1000
    memory: 4000Gi
  disruption:
    consolidationPolicy: WhenUnderutilized
    consolidateAfter: 1m
---
apiVersion: karpenter.k8s.aws/v1
kind: EC2NodeClass
metadata:
  name: application
spec:
  amiFamily: AL2023
  role: KarpenterNodeRole-prod-cluster
  subnetSelectorTerms:
    - tags:
        karpenter.sh/discovery: prod-cluster
  securityGroupSelectorTerms:
    - tags:
        karpenter.sh/discovery: prod-cluster
  instanceStorePolicy: RAID0
  blockDeviceMappings:
    - deviceName: /dev/xvda
      ebs:
        volumeSize: 100Gi
        volumeType: gp3
        iops: 3000
        throughput: 125
        encrypted: true
```

### Right-Sizing with VPA

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: api-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-deployment
  updatePolicy:
    updateMode: "Off"
  resourcePolicy:
    containerPolicies:
      - containerName: api
        minAllowed:
          cpu: 50m
          memory: 64Mi
        maxAllowed:
          cpu: 2
          memory: 2Gi
        controlledResources:
          - cpu
          - memory
```

```bash
# View VPA recommendations without applying
kubectl get vpa api-vpa -n production -o jsonpath='{.status.recommendation}' | jq .
```

## Section 10: EKS Anywhere and Multi-Environment

### EKS Anywhere for On-Premises

EKS Anywhere extends EKS to on-premises infrastructure using bare metal or VMware vSphere. It maintains API compatibility with cloud EKS while running on customer-managed infrastructure.

```yaml
# EKS Anywhere cluster configuration
apiVersion: anywhere.eks.amazonaws.com/v1alpha1
kind: Cluster
metadata:
  name: prod-onprem
spec:
  kubernetesVersion: "1.30"
  controlPlaneConfiguration:
    count: 3
    endpoint:
      host: "10.10.0.10"
    machineGroupRef:
      kind: VSphereMachineConfig
      name: control-plane-machines
  workerNodeGroupConfigurations:
    - count: 5
      machineGroupRef:
        kind: VSphereMachineConfig
        name: worker-machines
      name: md-0
  datacenterRef:
    kind: VSphereDatacenterConfig
    name: vsphere-datacenter
  clusterNetwork:
    cniConfig:
      cilium: {}
    pods:
      cidrBlocks:
        - 192.168.0.0/16
    services:
      cidrBlocks:
        - 10.96.0.0/12
```

### Multi-Account EKS with AWS Organizations

For multi-account EKS deployments, use AWS RAM to share VPC subnets across accounts and implement cross-account IRSA by federating OIDC providers.

```bash
# Share subnets across accounts with RAM
aws ram create-resource-share \
  --name eks-subnet-share \
  --resource-arns \
    arn:aws:ec2:us-east-1:NETWORK_ACCOUNT:subnet/subnet-PRIVATE1 \
    arn:aws:ec2:us-east-1:NETWORK_ACCOUNT:subnet/subnet-PRIVATE2 \
  --principals arn:aws:organizations::ROOT_ACCOUNT:organization/o-XXXXXXXXXX
```

## Section 11: Security Hardening

### Pod Security Standards

```bash
# Enforce restricted pod security standard on namespace
kubectl label namespace production \
  pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/enforce-version=v1.30 \
  pod-security.kubernetes.io/warn=restricted \
  pod-security.kubernetes.io/warn-version=v1.30 \
  pod-security.kubernetes.io/audit=restricted \
  pod-security.kubernetes.io/audit-version=v1.30
```

### EKS Network Policy with VPC CNI

```bash
# Enable network policy enforcement in VPC CNI
aws eks update-addon \
  --cluster-name prod-cluster \
  --addon-name vpc-cni \
  --configuration-values '{"enableNetworkPolicy": "true"}'
```

```yaml
# Default deny-all network policy
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: production
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-api-ingress
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: api
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              name: ingress-nginx
      ports:
        - port: 8080
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              name: database
      ports:
        - port: 5432
    - to:
        - namespaceSelector: {}
      ports:
        - port: 53
          protocol: UDP
```

### GuardDuty EKS Protection

```bash
# Enable GuardDuty EKS protection
aws guardduty create-detector \
  --enable \
  --features '[{"Name":"EKS_AUDIT_LOGS","Status":"ENABLED"},{"Name":"EKS_RUNTIME_MONITORING","Status":"ENABLED"}]'

# Get detector ID
DETECTOR_ID=$(aws guardduty list-detectors --query "DetectorIds[0]" --output text)

# Verify EKS protection is enabled
aws guardduty get-detector \
  --detector-id "${DETECTOR_ID}" \
  --query "Features"
```

## Section 12: Observability and Monitoring

### Amazon Managed Prometheus and Grafana

```bash
# Create AMP workspace
aws amp create-workspace \
  --alias prod-cluster-metrics \
  --region us-east-1

WORKSPACE_ID=$(aws amp list-workspaces \
  --query "workspaces[?alias=='prod-cluster-metrics'].workspaceId" \
  --output text)

# Install Prometheus with remote write to AMP
helm install prometheus prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --create-namespace \
  --set prometheus.prometheusSpec.remoteWrite[0].url="https://aps-workspaces.us-east-1.amazonaws.com/workspaces/${WORKSPACE_ID}/api/v1/remote_write" \
  --set prometheus.prometheusSpec.remoteWrite[0].sigv4.region=us-east-1 \
  --set prometheus.prometheusSpec.remoteWrite[0].sigv4.roleArn=arn:aws:iam::ACCOUNT_ID:role/PrometheusRemoteWriteRole \
  --set prometheus.serviceAccount.annotations."eks\.amazonaws\.com/role-arn"=arn:aws:iam::ACCOUNT_ID:role/PrometheusRemoteWriteRole
```

### Key EKS Metrics to Monitor

```yaml
# PrometheusRule for EKS-specific alerts
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: eks-alerts
  namespace: monitoring
spec:
  groups:
    - name: eks.node-groups
      interval: 60s
      rules:
        - alert: NodeGroupCapacityLow
          expr: |
            (kube_node_status_allocatable{resource="pods"} -
             kube_node_status_capacity{resource="pods"}) < 5
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Node approaching pod capacity limit"
            description: "Node {{ $labels.node }} has fewer than 5 allocatable pod slots remaining."

        - alert: SpotInstanceInterruptionHigh
          expr: |
            rate(aws_spot_interruption_total[5m]) > 0
          for: 1m
          labels:
            severity: warning
          annotations:
            summary: "Spot instance interruption detected"
```

## Section 13: Troubleshooting Common EKS Issues

### Node Not Joining Cluster

```bash
# Check node bootstrap logs
aws ssm start-session \
  --target i-INSTANCE_ID \
  --region us-east-1

# On the node
journalctl -u kubelet -f
cat /var/log/cloud-init-output.log | grep -i error

# Verify node IAM role has required policies
aws iam list-attached-role-policies \
  --role-name eksNodeRole \
  --query "AttachedPolicies[].PolicyName"
# Should include: AmazonEKSWorkerNodePolicy, AmazonEKS_CNI_Policy, AmazonEC2ContainerRegistryReadOnly
```

### Pod IP Exhaustion

```bash
# Check available IPs
kubectl get node -o custom-columns=\
"NAME:.metadata.name,\
MAX-PODS:.status.capacity.pods,\
ALLOC-PODS:.status.allocatable.pods,\
USED-PODS:.status.conditions[?(@.type=='Ready')].message"

# Check VPC CNI logs
kubectl logs -n kube-system -l k8s-app=aws-node --tail=100 | grep -i error

# Verify prefix delegation is active
kubectl get daemonset aws-node -n kube-system -o jsonpath='{.spec.template.spec.containers[0].env}' | jq '.[] | select(.name=="ENABLE_PREFIX_DELEGATION")'
```

### IRSA Token Issues

```bash
# Test IRSA configuration from within a pod
kubectl run -it --rm debug \
  --image=amazon/aws-cli:latest \
  --serviceaccount=app-s3-reader \
  --namespace=production \
  -- sts get-caller-identity

# Check token projection
kubectl get pod POD_NAME -o jsonpath='{.spec.volumes}' | jq '.[] | select(.name=="aws-iam-token")'
```

## Section 14: EKS Best Practices Summary

Production EKS deployments should follow these key principles:

**Infrastructure:**
- Use managed node groups for reduced operational overhead
- Implement spot instance groups for cost optimization with proper interruption handling
- Enable prefix delegation for improved pod density
- Configure VPC with dedicated subnets for nodes, pods, and load balancers

**Security:**
- Use IRSA instead of node-level IAM roles for workload identity
- Enable all control plane audit logs
- Implement network policies with VPC CNI network policy support
- Enable GuardDuty EKS Runtime Monitoring
- Apply pod security standards at namespace level

**Reliability:**
- Spread managed node groups across three availability zones
- Use PodDisruptionBudgets for all stateful workloads
- Configure cluster autoscaler or Karpenter for automatic scaling
- Test upgrades in staging before production

**Cost:**
- Use Compute Savings Plans for baseline compute
- Run burst workloads on spot instances
- Implement VPA recommendations for right-sizing
- Enable Karpenter consolidation to reclaim underutilized nodes

**Observability:**
- Route control plane logs to CloudWatch Logs
- Deploy Container Insights for infrastructure metrics
- Configure remote write to Amazon Managed Prometheus for long-term retention
- Set up cost allocation tags on all EKS resources
