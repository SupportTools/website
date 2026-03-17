---
title: "Kubernetes Karpenter Node Autoscaling: Provisioners, Disruption Budgets, and Spot Instance Optimization"
date: 2028-07-18T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Karpenter", "Autoscaling", "Spot Instances", "AWS", "Cost Optimization"]
categories:
- Kubernetes
- AWS
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Karpenter on AWS EKS covering NodePools, EC2NodeClass, spot instance interruption handling, disruption budgets, consolidation policies, and multi-architecture mixed instance fleet optimization."
more_link: "yes"
url: "/kubernetes-karpenter-node-autoscaling-guide/"
---

Karpenter replaced the Kubernetes Cluster Autoscaler as the standard node provisioner for AWS EKS and is gaining adoption on Azure and GCP. Its direct-to-cloud-API approach — bypassing Auto Scaling Groups for node launches — gives it a 3–5x speed advantage over traditional autoscalers and enables fine-grained bin-packing across hundreds of instance types simultaneously. This guide covers production Karpenter configuration patterns that save 40–70% on compute costs while maintaining reliability.

<!--more-->

# Kubernetes Karpenter Node Autoscaling: Provisioners, Disruption Budgets, and Spot Instance Optimization

## Section 1: Karpenter Architecture

### How Karpenter Differs from Cluster Autoscaler

| Feature | Cluster Autoscaler | Karpenter |
|---------|-------------------|-----------|
| Node provisioning | Via ASG | Direct EC2 API |
| Launch speed | 3–5 min | 45–90 sec |
| Instance selection | Pre-configured ASG | Dynamic from all instance types |
| Bin packing | One node per pod group | Optimal across all pending pods |
| Consolidation | No | Yes — merges underutilized nodes |
| Spot support | Via multiple ASGs | Native multi-type spot |
| ARM64 support | Pre-configured | Automatic via requirement matching |

### Control Flow

```
Pending Pod Created
       ↓
Karpenter Controller Watches
       ↓
Evaluate NodePool requirements + Pod resource requests
       ↓
Select optimal instance type(s) from EC2 fleet
       ↓
Call EC2 CreateFleet API (SpotInstances + On-Demand in priority order)
       ↓
Instance registers with Kubernetes (kubelet joins cluster)
       ↓
Pod scheduled to new node
```

---

## Section 2: Installation

### IAM Setup

```bash
# Create IAM role for Karpenter node
CLUSTER_NAME="production"
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
AWS_REGION="us-east-1"

# Node role — what nodes run as
cat > karpenter-node-role.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Service": "ec2.amazonaws.com"},
    "Action": "sts:AssumeRole"
  }]
}
EOF

aws iam create-role \
  --role-name KarpenterNodeRole-${CLUSTER_NAME} \
  --assume-role-policy-document file://karpenter-node-role.json

# Attach required policies to node role
for policy in AmazonEKSWorkerNodePolicy AmazonEKS_CNI_Policy \
              AmazonEC2ContainerRegistryReadOnly AmazonSSMManagedInstanceCore; do
  aws iam attach-role-policy \
    --role-name KarpenterNodeRole-${CLUSTER_NAME} \
    --policy-arn arn:aws:iam::aws:policy/${policy}
done

# Instance profile for nodes
aws iam create-instance-profile \
  --instance-profile-name KarpenterNodeInstanceProfile-${CLUSTER_NAME}
aws iam add-role-to-instance-profile \
  --instance-profile-name KarpenterNodeInstanceProfile-${CLUSTER_NAME} \
  --role-name KarpenterNodeRole-${CLUSTER_NAME}

# Karpenter controller role — what the controller runs as
eksctl create iamserviceaccount \
  --cluster "${CLUSTER_NAME}" \
  --namespace karpenter \
  --name karpenter \
  --role-name KarpenterControllerRole-${CLUSTER_NAME} \
  --attach-policy-arn arn:aws:iam::${AWS_ACCOUNT_ID}:policy/KarpenterControllerPolicy-${CLUSTER_NAME} \
  --approve
```

### Helm Installation

```bash
# Add Karpenter Helm repo
helm repo add karpenter https://charts.karpenter.sh/
helm repo update

# Get cluster endpoint and VPC ID
CLUSTER_ENDPOINT=$(aws eks describe-cluster --name ${CLUSTER_NAME} \
  --query cluster.endpoint --output text)
KARPENTER_IAM_ROLE_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:role/KarpenterControllerRole-${CLUSTER_NAME}"

# Install Karpenter
helm upgrade --install karpenter karpenter/karpenter \
  --namespace karpenter \
  --create-namespace \
  --version "0.37.0" \
  --set "settings.clusterName=${CLUSTER_NAME}" \
  --set "settings.clusterEndpoint=${CLUSTER_ENDPOINT}" \
  --set "settings.interruptionQueue=${CLUSTER_NAME}" \
  --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"="${KARPENTER_IAM_ROLE_ARN}" \
  --set controller.resources.requests.cpu=1 \
  --set controller.resources.requests.memory=1Gi \
  --set controller.resources.limits.cpu=1 \
  --set controller.resources.limits.memory=1Gi \
  --wait

# Verify Karpenter is running
kubectl get pods -n karpenter
kubectl logs -n karpenter -l app.kubernetes.io/name=karpenter -f
```

---

## Section 3: EC2NodeClass — Node Configuration

```yaml
# ec2nodeclass.yaml
apiVersion: karpenter.k8s.aws/v1
kind: EC2NodeClass
metadata:
  name: general-purpose
spec:
  # AMI selection — use Amazon Linux 2023 EKS-optimized
  amiSelectorTerms:
    - alias: al2023@latest   # Auto-select latest EKS-optimized AL2023
  # Alternative: pin to specific AMI family
  # amiSelectorTerms:
  #   - tags:
  #       karpenter.k8s.aws/discovery: "production"

  # Instance profile for EC2 nodes
  role: "KarpenterNodeRole-production"

  # Subnet selection — launch in private subnets
  subnetSelectorTerms:
    - tags:
        karpenter.sh/discovery: "production"
        kubernetes.io/role/internal-elb: "1"

  # Security groups — use same as other worker nodes
  securityGroupSelectorTerms:
    - tags:
        karpenter.sh/discovery: "production"

  # Instance metadata service — enforce IMDSv2
  metadataOptions:
    httpEndpoint: enabled
    httpProtocolIPv6: disabled
    httpPutResponseHopLimit: 1    # 1 = no containers can access IMDS
    httpTokens: required          # Enforce IMDSv2

  # EBS root volume configuration
  blockDeviceMappings:
    - deviceName: /dev/xvda
      ebs:
        volumeSize: 100Gi
        volumeType: gp3
        iops: 3000
        throughput: 125
        encrypted: true
        kmsKeyID: "arn:aws:kms:us-east-1:123456789012:key/your-kms-key-id"
        deleteOnTermination: true

  # User data for custom node configuration
  userData: |
    #!/bin/bash
    # Set kubelet reserved resources
    cat >> /etc/kubernetes/kubelet/kubelet-config.json << 'KUBELET_EOF'
    {
      "kubeReserved": {"cpu": "250m", "memory": "512Mi", "ephemeral-storage": "1Gi"},
      "systemReserved": {"cpu": "250m", "memory": "512Mi", "ephemeral-storage": "1Gi"},
      "evictionHard": {"memory.available": "200Mi", "nodefs.available": "10%"}
    }
    KUBELET_EOF

  # Tags applied to all launched instances
  tags:
    ManagedBy: karpenter
    Environment: production
    CostCenter: platform
```

### ARM64 NodeClass

```yaml
# ec2nodeclass-arm64.yaml
apiVersion: karpenter.k8s.aws/v1
kind: EC2NodeClass
metadata:
  name: arm64
spec:
  amiSelectorTerms:
    - alias: al2023@latest
  role: "KarpenterNodeRole-production"
  subnetSelectorTerms:
    - tags:
        karpenter.sh/discovery: "production"
  securityGroupSelectorTerms:
    - tags:
        karpenter.sh/discovery: "production"
  blockDeviceMappings:
    - deviceName: /dev/xvda
      ebs:
        volumeSize: 100Gi
        volumeType: gp3
        encrypted: true
        deleteOnTermination: true
  tags:
    ManagedBy: karpenter
    Arch: arm64
```

---

## Section 4: NodePool Configuration

### General-Purpose NodePool with Spot Priority

```yaml
# nodepool-general.yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: general
spec:
  template:
    metadata:
      labels:
        node-type: general
      annotations:
        node.alpha.kubernetes.io/ttl: "0"
    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: general-purpose

      requirements:
        # Architecture: prefer ARM (cheaper), allow x86
        - key: kubernetes.io/arch
          operator: In
          values: ["amd64", "arm64"]

        # Instance categories
        - key: karpenter.k8s.aws/instance-category
          operator: In
          values: ["c", "m", "r"]   # Compute, memory-balanced, memory-optimized

        # Instance generation — avoid old hardware
        - key: karpenter.k8s.aws/instance-generation
          operator: Gt
          values: ["3"]

        # Exclude burstable instances (t-family) for production
        - key: karpenter.k8s.aws/instance-family
          operator: NotIn
          values: ["t2", "t3", "t3a", "t4g"]

        # Prefer spot, fall back to on-demand
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot", "on-demand"]

        # OS
        - key: kubernetes.io/os
          operator: In
          values: ["linux"]

      # Max node lifetime — recycle nodes to get fresh AMIs
      expireAfter: 720h   # 30 days

  # Disruption configuration
  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 30s    # How long to wait before consolidating
    budgets:
      # Never disrupt more than 20% of nodes at once
      - nodes: "20%"
      # Don't disrupt nodes between 9am-5pm on weekdays (UTC-5)
      - schedule: "0 14 * * 1-5"   # 9am EST = 14:00 UTC
        duration: 8h
        nodes: "0"

  # Resource limits — prevent runaway scaling
  limits:
    cpu: "1000"         # 1000 vCPUs maximum
    memory: "4000Gi"    # 4 TB RAM maximum
```

### GPU NodePool

```yaml
# nodepool-gpu.yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: gpu
spec:
  template:
    metadata:
      labels:
        node-type: gpu
        nvidia.com/gpu: "true"
    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: general-purpose

      requirements:
        - key: karpenter.k8s.aws/instance-category
          operator: In
          values: ["p", "g"]   # GPU instances

        - key: karpenter.k8s.aws/instance-family
          operator: In
          values: ["p3", "p4d", "g4dn", "g5", "p4de", "p5"]

        - key: karpenter.sh/capacity-type
          operator: In
          values: ["on-demand"]   # GPU spot is less available — use on-demand

        - key: kubernetes.io/arch
          operator: In
          values: ["amd64"]

      taints:
        - key: nvidia.com/gpu
          value: "true"
          effect: NoSchedule

      expireAfter: 720h

  disruption:
    consolidationPolicy: WhenEmpty   # Only consolidate when completely empty
    budgets:
      - nodes: "10%"   # Very conservative for GPU workloads

  limits:
    cpu: "200"
    memory: "2000Gi"
    "nvidia.com/gpu": "50"
```

### Spot-Only NodePool for Fault-Tolerant Batch

```yaml
# nodepool-spot-batch.yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: spot-batch
spec:
  template:
    metadata:
      labels:
        node-type: spot-batch
    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: general-purpose

      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot"]   # Spot only

        - key: karpenter.k8s.aws/instance-category
          operator: In
          values: ["c", "m", "r"]

        # Wide instance selection maximizes spot availability
        - key: karpenter.k8s.aws/instance-cpu
          operator: In
          values: ["8", "16", "32", "48", "64"]

        - key: kubernetes.io/arch
          operator: In
          values: ["amd64", "arm64"]

      taints:
        - key: node-type
          value: spot-batch
          effect: NoSchedule

  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 0s   # Immediate consolidation for batch

  limits:
    cpu: "2000"
    memory: "8000Gi"
```

---

## Section 5: Pod Configuration for Karpenter

### Requesting Specific Node Types

```yaml
# deployment-spot-tolerant.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-api
spec:
  replicas: 10
  selector:
    matchLabels:
      app: web-api
  template:
    metadata:
      labels:
        app: web-api
    spec:
      # Tolerate spot instance interruptions
      tolerations:
        - key: karpenter.sh/capacity-type
          operator: Equal
          value: spot
          effect: NoSchedule

      # Prefer spot, but allow on-demand fallback
      affinity:
        nodeAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              preference:
                matchExpressions:
                  - key: karpenter.sh/capacity-type
                    operator: In
                    values: ["spot"]

      # Topology spread for HA across AZs
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: web-api
        - maxSkew: 2
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: web-api

      # Graceful shutdown for spot interruption
      terminationGracePeriodSeconds: 30

      containers:
        - name: web-api
          image: your-registry/web-api:1.0.0
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: 2000m
              memory: 2Gi

          # Handle spot interruption signal (SIGTERM)
          lifecycle:
            preStop:
              exec:
                command: ["/bin/sh", "-c", "sleep 5"]

          readinessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 5
            failureThreshold: 3
            periodSeconds: 5
```

### Batch Job on Spot with Retry on Interruption

```yaml
# batch-job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: data-processor
spec:
  completions: 100
  parallelism: 20
  backoffLimit: 50       # Allow retries for spot interruptions
  completionMode: Indexed
  template:
    spec:
      restartPolicy: OnFailure

      tolerations:
        - key: node-type
          value: spot-batch
          effect: NoSchedule
        - key: karpenter.sh/interruption
          effect: NoSchedule

      nodeSelector:
        node-type: spot-batch

      # Avoid placing too many batch tasks on same node
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 50
              podAffinityTerm:
                labelSelector:
                  matchLabels:
                    job-name: data-processor
                topologyKey: kubernetes.io/hostname

      # Short termination grace — batch tasks should checkpoint frequently
      terminationGracePeriodSeconds: 60

      containers:
        - name: processor
          image: your-registry/batch-processor:1.0.0
          env:
            - name: JOB_COMPLETION_INDEX
              valueFrom:
                fieldRef:
                  fieldPath: metadata.annotations['batch.kubernetes.io/job-completion-index']
          resources:
            requests:
              cpu: 4
              memory: 16Gi
            limits:
              cpu: 8
              memory: 32Gi
```

---

## Section 6: Spot Instance Interruption Handling

### SQS Queue for Interruption Notices

Karpenter monitors AWS spot interruption notices via SQS and proactively drains nodes before they are reclaimed.

```bash
# Create SQS queue for interruption handling
aws sqs create-queue \
  --queue-name "KarpenterInterruption-${CLUSTER_NAME}" \
  --attributes '{
    "MessageRetentionPeriod": "300",
    "VisibilityTimeout": "30"
  }'

# Create EventBridge rules to send spot interruption notices to SQS
QUEUE_ARN=$(aws sqs get-queue-attributes \
  --queue-url "https://sqs.${AWS_REGION}.amazonaws.com/${AWS_ACCOUNT_ID}/KarpenterInterruption-${CLUSTER_NAME}" \
  --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)

aws events put-rule \
  --name "KarpenterInterruptionRule" \
  --event-pattern '{
    "source": ["aws.ec2"],
    "detail-type": [
      "EC2 Spot Instance Interruption Warning",
      "EC2 Instance Rebalance Recommendation",
      "EC2 Instance State-change Notification"
    ]
  }'

aws events put-targets \
  --rule KarpenterInterruptionRule \
  --targets "Id=KarpenterInterruptionTarget,Arn=${QUEUE_ARN}"
```

### Application-Level Interruption Handling

```go
// interruption/handler.go — gracefully handle spot termination in Go services
package interruption

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

// SpotInterruptionHandler polls the EC2 metadata service for spot interruption notices
type SpotInterruptionHandler struct {
	checkInterval time.Duration
	onInterrupt   func()
	log           *slog.Logger
}

func NewSpotInterruptionHandler(interval time.Duration, onInterrupt func(), logger *slog.Logger) *SpotInterruptionHandler {
	return &SpotInterruptionHandler{
		checkInterval: interval,
		onInterrupt:   onInterrupt,
		log:           logger,
	}
}

// Watch polls EC2 metadata for spot interruption every checkInterval
func (h *SpotInterruptionHandler) Watch(ctx context.Context) {
	ticker := time.NewTicker(h.checkInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if h.isInterrupted() {
				h.log.Warn("Spot interruption notice received — initiating graceful shutdown")
				h.onInterrupt()
				return
			}
		}
	}
}

func (h *SpotInterruptionHandler) isInterrupted() bool {
	// IMDSv2: get token first
	tokenReq, _ := http.NewRequest("PUT",
		"http://169.254.169.254/latest/api/token", nil)
	tokenReq.Header.Set("X-aws-ec2-metadata-token-ttl-seconds", "30")

	client := &http.Client{Timeout: 2 * time.Second}
	tokenResp, err := client.Do(tokenReq)
	if err != nil {
		return false
	}
	defer tokenResp.Body.Close()
	token, _ := io.ReadAll(tokenResp.Body)

	// Check for spot termination notice
	req, _ := http.NewRequest("GET",
		"http://169.254.169.254/latest/meta-data/spot/termination-time", nil)
	req.Header.Set("X-aws-ec2-metadata-token", string(token))

	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()

	// 200 means termination notice is present
	return resp.StatusCode == 200
}

// GracefulShutdown coordinates service shutdown on interruption
func GracefulShutdown(ctx context.Context, timeout time.Duration, servers ...*http.Server) {
	ctx, stop := signal.NotifyContext(ctx, syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	<-ctx.Done()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	var wg sync.WaitGroup
	for _, srv := range servers {
		wg.Add(1)
		go func(s *http.Server) {
			defer wg.Done()
			s.Shutdown(shutdownCtx)
		}(srv)
	}
	wg.Wait()
}
```

---

## Section 7: NodePool Disruption Budgets

### Production Disruption Budget Configuration

```yaml
# nodepool with fine-grained disruption control
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: production-critical
spec:
  template:
    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: general-purpose
      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["on-demand"]   # Never use spot for critical workloads
        - key: karpenter.k8s.aws/instance-family
          operator: In
          values: ["m6i", "m6a", "m7i", "m7a", "m7g"]
        - key: kubernetes.io/arch
          operator: In
          values: ["amd64", "arm64"]
      expireAfter: 2160h  # 90 days

  disruption:
    # Only consolidate when nodes are empty
    consolidationPolicy: WhenEmpty
    consolidateAfter: 5m

    # Multi-window budget configuration
    budgets:
      # Never disrupt more than 5% of nodes
      - nodes: "5%"

      # No disruption during peak traffic hours (Mon-Fri 8am-8pm EST)
      - schedule: "0 13 * * 1-5"   # 8am EST = 13:00 UTC
        duration: 12h
        nodes: "0"

      # No disruption during deployments
      # Managed externally via: kubectl annotate nodepool production-critical karpenter.sh/do-not-disrupt=true
      # Removed when deployment finishes

  limits:
    cpu: "500"
    memory: "2000Gi"
---
# Pod Disruption Budget for the applications on these nodes
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: web-api-pdb
  namespace: production
spec:
  minAvailable: 75%   # At least 75% of replicas must remain available
  selector:
    matchLabels:
      app: web-api
```

### Pausing Disruption During Deployments

```bash
#!/bin/bash
# deploy-with-karpenter-pause.sh — pause Karpenter disruption during deployments

NODEPOOL="production-critical"
DEPLOYMENT="web-api"
NAMESPACE="production"

echo "Pausing Karpenter disruption for NodePool: ${NODEPOOL}"
kubectl annotate nodepool "${NODEPOOL}" karpenter.sh/do-not-disrupt=true

# Perform the deployment
kubectl set image deployment/${DEPLOYMENT} \
  app=your-registry/web-api:${NEW_VERSION} \
  -n ${NAMESPACE}

# Wait for rollout
kubectl rollout status deployment/${DEPLOYMENT} -n ${NAMESPACE} --timeout=10m

echo "Deployment complete, resuming Karpenter disruption"
kubectl annotate nodepool "${NODEPOOL}" karpenter.sh/do-not-disrupt-

# Also pause disruption on specific nodes during maintenance
# kubectl annotate node <node-name> karpenter.sh/do-not-disrupt=true
```

---

## Section 8: Cost Optimization Strategies

### Mixed On-Demand and Spot with Priority

```yaml
# Two NodePools: on-demand base + spot burst
---
# On-demand floor for baseline capacity
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: on-demand-base
spec:
  template:
    metadata:
      labels:
        capacity-type: on-demand
    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: general-purpose
      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["on-demand"]
        - key: karpenter.k8s.aws/instance-family
          operator: In
          values: ["m7i", "m7a", "m7g", "m6i", "m6a"]
        - key: karpenter.k8s.aws/instance-cpu
          operator: In
          values: ["4", "8"]   # Smaller, cheaper per-unit instances
  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 5m
    budgets:
      - nodes: "10%"
  limits:
    cpu: "200"   # Base: 200 vCPUs on-demand
    memory: "800Gi"
---
# Spot for burst capacity
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: spot-burst
spec:
  # Weight: higher weight = preferred by Karpenter
  weight: 50   # On-demand-base has default weight 10; this runs alongside it
  template:
    metadata:
      labels:
        capacity-type: spot
    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: general-purpose
      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot"]
        - key: karpenter.k8s.aws/instance-category
          operator: In
          values: ["c", "m", "r"]
        - key: karpenter.k8s.aws/instance-cpu
          operator: In
          values: ["4", "8", "16", "32"]
        - key: kubernetes.io/arch
          operator: In
          values: ["amd64", "arm64"]
  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 30s   # Quick consolidation for spot
    budgets:
      - nodes: "30%"
  limits:
    cpu: "800"   # Allow significant spot burst
    memory: "3200Gi"
```

### Scheduling Pods to Prefer Spot

```yaml
# Use node affinity weights to prefer spot but allow on-demand
spec:
  affinity:
    nodeAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
        # Strong preference for spot
        - weight: 80
          preference:
            matchExpressions:
              - key: karpenter.sh/capacity-type
                operator: In
                values: ["spot"]
        # Prefer ARM (Graviton) on spot for additional cost savings
        - weight: 20
          preference:
            matchExpressions:
              - key: kubernetes.io/arch
                operator: In
                values: ["arm64"]
```

---

## Section 9: Monitoring and Troubleshooting

### Karpenter Metrics

```bash
# Check Karpenter metrics endpoint
kubectl port-forward -n karpenter svc/karpenter 8080:8080
curl -s localhost:8080/metrics | grep karpenter

# Key metrics:
# karpenter_nodes_total — total nodes managed
# karpenter_pods_state — pending/running pod counts
# karpenter_nodeclaims_total — node claim lifecycle
# karpenter_disruption_evaluation_duration_seconds — how long disruption decisions take
# karpenter_provisioner_scheduling_duration_seconds — scheduling loop latency
```

### Prometheus Alerting Rules

```yaml
# prometheus-rules.yaml
groups:
  - name: karpenter.rules
    rules:
      - alert: KarpenterHighPendingPods
        expr: karpenter_pods_state{state="Pending"} > 50
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "High number of pending pods"
          description: "{{ $value }} pods are pending. Karpenter may not be able to provision nodes."

      - alert: KarpenterNodeProvisioningFailed
        expr: rate(karpenter_nodeclaims_total{state="failed"}[5m]) > 0
        labels:
          severity: critical
        annotations:
          summary: "Karpenter node provisioning failures"
          description: "Karpenter is failing to provision nodes. Check EC2 limits and IAM permissions."

      - alert: KarpenterNodeDriftDetected
        expr: karpenter_nodeclaims_total{state="drifted"} > 5
        labels:
          severity: warning
        annotations:
          summary: "Karpenter nodes drifting from desired state"
```

### Debugging Commands

```bash
# View all NodeClaims (individual node requests)
kubectl get nodeclaims -A

# View NodePool status
kubectl describe nodepool general

# Check why pods are pending
kubectl describe pod <pending-pod>

# View Karpenter decision logs
kubectl logs -n karpenter -l app.kubernetes.io/name=karpenter \
  --since=5m | grep -E "ERROR|WARN|provisioning|consolidating"

# Show nodes provisioned by Karpenter with their instance types
kubectl get nodes -l karpenter.sh/nodepool \
  -o custom-columns=\
NAME:.metadata.name,\
NODEPOOL:.metadata.labels.karpenter\\.sh/nodepool,\
INSTANCE:.metadata.labels.node\\.kubernetes\\.io/instance-type,\
CAPACITY:.metadata.labels.karpenter\\.sh/capacity-type,\
ZONE:.metadata.labels.topology\\.kubernetes\\.io/zone,\
CPU:.status.allocatable.cpu,\
MEM:.status.allocatable.memory

# Force Karpenter to evaluate disruption now
kubectl annotate nodepool general karpenter.sh/consolidation-enabled=true

# Calculate potential cost savings from consolidation
kubectl get nodes -l karpenter.sh/nodepool=general \
  -o jsonpath='{range .items[*]}{.metadata.labels.node\.kubernetes\.io/instance-type}{"\n"}{end}' \
  | sort | uniq -c | sort -rn
```

### Drift Detection

When AMIs or EC2NodeClass configurations change, Karpenter detects "drift" and replaces nodes automatically:

```bash
# View nodes in drifted state
kubectl get nodeclaims -o json | \
  jq '.items[] | select(.status.conditions[] | select(.type=="Drifted" and .status=="True")) | .metadata.name'

# Trigger immediate drift replacement (normally Karpenter does this automatically)
kubectl delete nodeclaim <name>

# Disable drift for a specific node (emergency)
kubectl annotate node <node-name> karpenter.sh/do-not-disrupt=true
```

Karpenter delivers the most value when combined with wide instance family requirements (letting it pick from 50+ instance types) and spot interruption-tolerant application design. The consolidation feature alone typically recovers 15–30% of wasted compute resources, while the spot/on-demand mixing reduces raw compute spend by 40–70% for fault-tolerant workloads.
