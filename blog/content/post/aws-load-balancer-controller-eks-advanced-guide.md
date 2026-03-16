---
title: "AWS Load Balancer Controller: ALB and NLB for EKS"
date: 2027-02-07T00:00:00-05:00
draft: false
tags: ["Kubernetes", "AWS", "EKS", "Load Balancer", "ALB", "NLB"]
categories: ["Cloud Architecture", "Kubernetes", "AWS"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to the AWS Load Balancer Controller for EKS, covering ALB Ingress, NLB Services, IRSA setup, IngressGroup shared ALBs, WAF integration, TargetGroupBinding for blue-green deployments, and cost optimization strategies."
more_link: "yes"
url: "/aws-load-balancer-controller-eks-advanced-guide/"
---

The **AWS Load Balancer Controller** (LBC) provisions and manages Application Load Balancers and Network Load Balancers directly from Kubernetes resources, replacing the legacy in-tree cloud-provider load balancer code with a dedicated controller that supports modern AWS features: native IP-mode routing, WAF integration, shared ALBs across namespaces, and TargetGroupBinding for external traffic management. This guide covers the complete operational picture from IRSA setup through cost optimization for production EKS clusters.

<!--more-->

## Architecture Overview

The AWS LBC runs as a Deployment in the `kube-system` namespace and watches four Kubernetes resource types: `Ingress` (ALB), `Service` (NLB), `IngressGroup` (shared ALB), and `TargetGroupBinding` (external TG attachment). Reconciliation is event-driven; the controller calls the EC2 and ELBv2 APIs to create or update load balancer resources and registers pod IPs directly as targets when using **IP target mode**.

```
Kubernetes Ingress / Service
         ↓
  AWS LBC (watches via informers)
         ↓
  EC2 / ELBv2 API calls
         ↓
  ALB (HTTP/HTTPS) or NLB (TCP/UDP/TLS)
         ↓
  Target Group (instance or ip mode)
         ↓
  Pod ENI endpoints
```

### IP mode vs instance mode

| | Instance mode | IP mode |
|---|---|---|
| Target | EC2 node port | Pod IP directly |
| Source IP preservation | Requires `externalTrafficPolicy: Local` | Native |
| kube-proxy dependency | Yes (NodePort DNAT) | No |
| Cross-AZ optimization | Limited | Full |
| Requirements | Any VPC config | ENI-based pod networking (VPC CNI) |

IP mode is strongly preferred for EKS with VPC CNI because it eliminates an extra hop through `kube-proxy` and preserves the original client IP for all backends.

## IRSA Setup

The controller requires IAM permissions to create and manage ELB resources. **IAM Roles for Service Accounts** (IRSA) is the recommended approach, avoiding node-level IAM roles that would grant all pods on the node the same permissions.

```bash
#!/bin/bash
set -euo pipefail

CLUSTER_NAME="production-eks"
AWS_REGION="us-east-1"
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# 1. Associate OIDC provider with the cluster (idempotent)
eksctl utils associate-iam-oidc-provider \
  --region "${AWS_REGION}" \
  --cluster "${CLUSTER_NAME}" \
  --approve

OIDC_PROVIDER=$(aws eks describe-cluster \
  --name "${CLUSTER_NAME}" \
  --region "${AWS_REGION}" \
  --query "cluster.identity.oidc.issuer" \
  --output text | sed 's|https://||')

# 2. Download the AWS-managed LBC IAM policy
curl -o /tmp/iam-policy.json \
  https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/v2.7.1/docs/install/iam_policy.json

# 3. Create the IAM policy
aws iam create-policy \
  --policy-name AWSLoadBalancerControllerIAMPolicy \
  --policy-document file:///tmp/iam-policy.json 2>/dev/null || true

# 4. Create the IAM role with trust policy
cat > /tmp/trust-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::${AWS_ACCOUNT_ID}:oidc-provider/${OIDC_PROVIDER}"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "${OIDC_PROVIDER}:aud": "sts.amazonaws.com",
          "${OIDC_PROVIDER}:sub": "system:serviceaccount:kube-system:aws-load-balancer-controller"
        }
      }
    }
  ]
}
EOF

aws iam create-role \
  --role-name AWSLoadBalancerControllerRole \
  --assume-role-policy-document file:///tmp/trust-policy.json 2>/dev/null || true

aws iam attach-role-policy \
  --role-name AWSLoadBalancerControllerRole \
  --policy-arn "arn:aws:iam::${AWS_ACCOUNT_ID}:policy/AWSLoadBalancerControllerIAMPolicy"

echo "IAM Role ARN: arn:aws:iam::${AWS_ACCOUNT_ID}:role/AWSLoadBalancerControllerRole"
```

## Installing the Controller

```bash
#!/bin/bash
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
AWS_REGION="us-east-1"
CLUSTER_NAME="production-eks"
LBC_VERSION="v2.7.1"

# Install cert-manager (required for webhook TLS)
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.14.4/cert-manager.yaml
kubectl -n cert-manager rollout status deployment/cert-manager-webhook --timeout=120s

# Add the EKS Helm repository
helm repo add eks https://aws.github.io/eks-charts
helm repo update

# Create the ServiceAccount with IRSA annotation
kubectl create serviceaccount aws-load-balancer-controller \
  -n kube-system \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl annotate serviceaccount aws-load-balancer-controller \
  -n kube-system \
  "eks.amazonaws.com/role-arn=arn:aws:iam::${AWS_ACCOUNT_ID}:role/AWSLoadBalancerControllerRole" \
  --overwrite

# Install the controller
helm upgrade --install aws-load-balancer-controller eks/aws-load-balancer-controller \
  --namespace kube-system \
  --version "${LBC_VERSION}" \
  --set clusterName="${CLUSTER_NAME}" \
  --set region="${AWS_REGION}" \
  --set serviceAccount.create=false \
  --set serviceAccount.name=aws-load-balancer-controller \
  --set replicaCount=2 \
  --set podDisruptionBudget.minAvailable=1 \
  --set resources.requests.cpu=100m \
  --set resources.requests.memory=128Mi \
  --set resources.limits.cpu=500m \
  --set resources.limits.memory=512Mi \
  --set enableShield=false \
  --set enableWaf=true \
  --set enableWafv2=true \
  --wait

kubectl -n kube-system rollout status deployment/aws-load-balancer-controller
```

## ALB Ingress Configuration

### Basic HTTPS Ingress with ACM

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-ingress
  namespace: app-team-a
  annotations:
    # Use ALB (required)
    kubernetes.io/ingress.class: alb

    # ALB scheme: internet-facing or internal
    alb.ingress.kubernetes.io/scheme: internet-facing

    # IP target mode (preferred for VPC CNI)
    alb.ingress.kubernetes.io/target-type: ip

    # ACM certificate ARN
    alb.ingress.kubernetes.io/certificate-arn: >
      arn:aws:acm:us-east-1:123456789012:certificate/a1b2c3d4-e5f6-7890-abcd-ef1234567890

    # Redirect HTTP to HTTPS
    alb.ingress.kubernetes.io/actions.ssl-redirect: >
      {"Type":"redirect","RedirectConfig":{"Protocol":"HTTPS","Port":"443","StatusCode":"HTTP_301"}}

    # SSL policy
    alb.ingress.kubernetes.io/ssl-policy: ELBSecurityPolicy-TLS13-1-2-2021-06

    # Health check configuration
    alb.ingress.kubernetes.io/healthcheck-path: /health
    alb.ingress.kubernetes.io/healthcheck-interval-seconds: "15"
    alb.ingress.kubernetes.io/healthcheck-timeout-seconds: "5"
    alb.ingress.kubernetes.io/healthy-threshold-count: "2"
    alb.ingress.kubernetes.io/unhealthy-threshold-count: "3"
    alb.ingress.kubernetes.io/success-codes: "200,204"

    # Connection draining
    alb.ingress.kubernetes.io/target-group-attributes: >
      deregistration_delay.timeout_seconds=60,
      slow_start.duration_seconds=30,
      stickiness.enabled=false

    # Security group
    alb.ingress.kubernetes.io/security-groups: sg-0123456789abcdef0

    # Tags for cost allocation
    alb.ingress.kubernetes.io/tags: >
      Environment=production,Team=platform,CostCenter=engineering
spec:
  ingressClassName: alb
  rules:
    # HTTP → HTTPS redirect rule
    - http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: ssl-redirect
                port:
                  name: use-annotation
    # HTTPS rules
    - host: api.example.com
      http:
        paths:
          - path: /v1/
            pathType: Prefix
            backend:
              service:
                name: api-v1-svc
                port:
                  number: 8080
          - path: /v2/
            pathType: Prefix
            backend:
              service:
                name: api-v2-svc
                port:
                  number: 8080
```

### Advanced listener rules with actions

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: advanced-routing
  namespace: app-team-a
  annotations:
    kubernetes.io/ingress.class: alb
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip

    # Fixed response for maintenance
    alb.ingress.kubernetes.io/actions.maintenance-response: >
      {"type":"fixed-response","fixedResponseConfig":{"contentType":"text/html","statusCode":"503","messageBody":"<html><body><h1>Maintenance</h1></body></html>"}}

    # Forward with custom weights for canary
    alb.ingress.kubernetes.io/actions.canary-forward: >
      {"type":"forward","forwardConfig":{"targetGroups":[{"serviceName":"api-stable-svc","servicePort":"8080","weight":90},{"serviceName":"api-canary-svc","servicePort":"8080","weight":10}],"targetGroupStickinessConfig":{"enabled":true,"durationSeconds":600}}}

    # Conditions using query strings
    alb.ingress.kubernetes.io/conditions.canary-forward: >
      [{"field":"query-string","queryStringConfig":{"values":[{"key":"canary","value":"true"}]}}]
spec:
  ingressClassName: alb
  rules:
    - host: app.example.com
      http:
        paths:
          - path: /canary
            pathType: Prefix
            backend:
              service:
                name: canary-forward
                port:
                  name: use-annotation
          - path: /
            pathType: Prefix
            backend:
              service:
                name: api-stable-svc
                port:
                  number: 8080
```

## IngressGroup: Shared ALB Across Namespaces

**IngressGroup** allows multiple Ingress resources to share a single ALB, reducing cost and consolidating certificate management. Rules are merged based on `group.order` with lower numbers taking priority.

```yaml
# Team A's Ingress
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: team-a-ingress
  namespace: app-team-a
  annotations:
    kubernetes.io/ingress.class: alb
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/certificate-arn: >
      arn:aws:acm:us-east-1:123456789012:certificate/a1b2c3d4-e5f6-7890-abcd-ef1234567890
    # Join the shared group
    alb.ingress.kubernetes.io/group.name: production-shared
    alb.ingress.kubernetes.io/group.order: "10"
spec:
  ingressClassName: alb
  rules:
    - host: team-a.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: team-a-svc
                port:
                  number: 8080
---
# Team B's Ingress (same ALB, different host)
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: team-b-ingress
  namespace: app-team-b
  annotations:
    kubernetes.io/ingress.class: alb
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/certificate-arn: >
      arn:aws:acm:us-east-1:123456789012:certificate/a1b2c3d4-e5f6-7890-abcd-ef1234567890
    alb.ingress.kubernetes.io/group.name: production-shared
    alb.ingress.kubernetes.io/group.order: "20"
spec:
  ingressClassName: alb
  rules:
    - host: team-b.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: team-b-svc
                port:
                  number: 8080
```

With IngressGroup, both teams share one ALB. The ALB cost is ~$20/month rather than $40/month for two separate load balancers. At scale (50+ microservices), this consolidation is significant.

## NLB for TCP/UDP Workloads

Network Load Balancers operate at Layer 4 and are suitable for TCP/UDP protocols, very high throughput, ultra-low latency requirements, and source IP preservation without proxy protocol.

```yaml
# NLB Service for a TCP application
apiVersion: v1
kind: Service
metadata:
  name: tcp-app-nlb
  namespace: app-team-a
  annotations:
    # Use NLB
    service.beta.kubernetes.io/aws-load-balancer-type: external
    service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: ip
    service.beta.kubernetes.io/aws-load-balancer-scheme: internet-facing

    # Health check
    service.beta.kubernetes.io/aws-load-balancer-healthcheck-path: /health
    service.beta.kubernetes.io/aws-load-balancer-healthcheck-port: "8080"
    service.beta.kubernetes.io/aws-load-balancer-healthcheck-protocol: HTTP
    service.beta.kubernetes.io/aws-load-balancer-healthcheck-interval: "10"
    service.beta.kubernetes.io/aws-load-balancer-healthcheck-healthy-threshold: "2"
    service.beta.kubernetes.io/aws-load-balancer-healthcheck-unhealthy-threshold: "3"

    # Cross-zone load balancing
    service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled: "true"

    # Connection draining
    service.beta.kubernetes.io/aws-load-balancer-target-group-attributes: >
      deregistration_delay.timeout_seconds=30,preserve_client_ip.enabled=true

    # Assign static Elastic IPs per AZ
    service.beta.kubernetes.io/aws-load-balancer-eip-allocations: >
      eipalloc-0123456789abcdef0,eipalloc-abcdef0123456789,eipalloc-fedcba9876543210

    # Security groups (NLB with IP mode)
    service.beta.kubernetes.io/aws-load-balancer-security-groups: sg-0123456789abcdef0

    # Tags
    service.beta.kubernetes.io/aws-load-balancer-additional-resource-tags: >
      Environment=production,Team=platform
spec:
  type: LoadBalancer
  loadBalancerClass: service.k8s.aws/nlb
  selector:
    app: tcp-app
  ports:
    - name: tcp
      protocol: TCP
      port: 443
      targetPort: 8443
    - name: udp
      protocol: UDP
      port: 1194
      targetPort: 1194
```

### NLB with TLS termination

```yaml
apiVersion: v1
kind: Service
metadata:
  name: tls-nlb
  namespace: app-team-a
  annotations:
    service.beta.kubernetes.io/aws-load-balancer-type: external
    service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: ip
    service.beta.kubernetes.io/aws-load-balancer-scheme: internet-facing

    # TLS termination at NLB with ACM cert
    service.beta.kubernetes.io/aws-load-balancer-ssl-cert: >
      arn:aws:acm:us-east-1:123456789012:certificate/a1b2c3d4-e5f6-7890-abcd-ef1234567890
    service.beta.kubernetes.io/aws-load-balancer-ssl-ports: "443"
    service.beta.kubernetes.io/aws-load-balancer-ssl-negotiation-policy: ELBSecurityPolicy-TLS13-1-2-2021-06

    # Backend receives plain TCP after NLB TLS termination
    service.beta.kubernetes.io/aws-load-balancer-backend-protocol: tcp
spec:
  type: LoadBalancer
  loadBalancerClass: service.k8s.aws/nlb
  selector:
    app: backend-app
  ports:
    - name: https
      protocol: TCP
      port: 443
      targetPort: 8080
```

## WAF Integration

The AWS LBC supports associating an AWS WAF v2 WebACL with an ALB through annotations. WAF rules protect against OWASP Top 10 threats, managed rule groups, and custom IP-based rules.

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: waf-protected-ingress
  namespace: app-team-a
  annotations:
    kubernetes.io/ingress.class: alb
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip

    # Attach WAF v2 WebACL
    alb.ingress.kubernetes.io/wafv2-acl-arn: >
      arn:aws:wafv2:us-east-1:123456789012:regional/webacl/production-waf/abcd1234-ef56-7890-abcd-ef1234567890

    # Enable AWS Shield Advanced (requires subscription)
    alb.ingress.kubernetes.io/shield-advanced-protection: "true"
spec:
  ingressClassName: alb
  rules:
    - host: protected-app.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: protected-app-svc
                port:
                  number: 8080
```

Create the WAF WebACL with managed rule groups using CloudFormation or Terraform before referencing it in the annotation:

```bash
# Verify the WebACL is associated after applying the Ingress
ALB_ARN=$(aws elbv2 describe-load-balancers \
  --query "LoadBalancers[?contains(LoadBalancerName, 'k8s-appteama')].LoadBalancerArn" \
  --output text)

aws wafv2 get-web-acl-for-resource \
  --resource-arn "${ALB_ARN}" \
  --region us-east-1
```

## Security Group Management

The controller can manage security group rules automatically when using IP target mode. The `aws-load-balancer-manage-backend-security-group-rules` annotation controls whether LBC adds inbound rules to the pod security group.

```yaml
# Namespace-level IngressClass parameters
apiVersion: networking.k8s.io/v1
kind: IngressClass
metadata:
  name: alb
spec:
  controller: ingress.k8s.aws/alb
  parameters:
    apiGroup: elbv2.k8s.aws
    kind: IngressClassParams
    name: production-params
---
apiVersion: elbv2.k8s.aws/v1beta1
kind: IngressClassParams
metadata:
  name: production-params
spec:
  scheme: internet-facing
  ipAddressType: dualstack
  group:
    name: production-shared
  # Load balancer attributes applying to all Ingresses in this class
  loadBalancerAttributes:
    - key: idle_timeout.timeout_seconds
      value: "60"
    - key: routing.http.drop_invalid_header_fields.enabled
      value: "true"
    - key: routing.http2.enabled
      value: "true"
    - key: access_logs.s3.enabled
      value: "true"
    - key: access_logs.s3.bucket
      value: "company-alb-access-logs"
    - key: access_logs.s3.prefix
      value: "production"
```

## TargetGroupBinding for Blue/Green Deployments

**TargetGroupBinding** allows attaching pre-created AWS Target Groups to Kubernetes Service endpoints without creating a full ALB/NLB. This enables advanced blue/green and canary deployment patterns driven by external tools like AWS CodeDeploy.

```yaml
# Blue (current production) TargetGroupBinding
apiVersion: elbv2.k8s.aws/v1beta1
kind: TargetGroupBinding
metadata:
  name: api-blue-tgb
  namespace: app-team-a
spec:
  serviceRef:
    name: api-blue-svc
    port: 8080
  targetGroupARN: arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/api-blue/abcd1234ef567890
  targetType: ip
  networking:
    ingress:
      - from:
          - securityGroup:
              groupID: sg-0123456789abcdef0
        ports:
          - port: 8080
            protocol: TCP
---
# Green (new version) TargetGroupBinding
apiVersion: elbv2.k8s.aws/v1beta1
kind: TargetGroupBinding
metadata:
  name: api-green-tgb
  namespace: app-team-a
spec:
  serviceRef:
    name: api-green-svc
    port: 8080
  targetGroupARN: arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/api-green/1234abcdef567890
  targetType: ip
  networking:
    ingress:
      - from:
          - securityGroup:
              groupID: sg-0123456789abcdef0
        ports:
          - port: 8080
            protocol: TCP
```

Shift traffic by updating ALB listener rules or using weighted target group forwarding:

```bash
#!/bin/bash
# Shift 10% traffic to green
ALB_ARN="arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/production-alb/abcd1234567890ef"
RULE_ARN=$(aws elbv2 describe-rules \
  --listener-arn "$(aws elbv2 describe-listeners \
    --load-balancer-arn "${ALB_ARN}" \
    --query 'Listeners[?Port==`443`].ListenerArn' \
    --output text)" \
  --query 'Rules[?Priority==`10`].RuleArn' \
  --output text)

aws elbv2 modify-rule \
  --rule-arn "${RULE_ARN}" \
  --actions Type=forward,ForwardConfig="{
    TargetGroups=[
      {TargetGroupArn=arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/api-blue/abcd1234ef567890,Weight=90},
      {TargetGroupArn=arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/api-green/1234abcdef567890,Weight=10}
    ]
  }"
```

## Cross-Zone Load Balancing

Cross-zone load balancing is critical for AZ-imbalanced workloads. For NLBs, it has cost implications (inter-AZ data transfer charges); for ALBs it is always enabled and has no per-transfer charge.

```yaml
# NLB: enable cross-zone (note: incurs inter-AZ data transfer costs)
apiVersion: v1
kind: Service
metadata:
  name: crosszone-nlb
  namespace: app-team-a
  annotations:
    service.beta.kubernetes.io/aws-load-balancer-type: external
    service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: ip
    service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled: "true"
    # Alternatively: use load_balancing.cross_zone.enabled attribute
    service.beta.kubernetes.io/aws-load-balancer-target-group-attributes: >
      load_balancing.cross_zone.enabled=true
spec:
  type: LoadBalancer
  loadBalancerClass: service.k8s.aws/nlb
  selector:
    app: backend
  ports:
    - protocol: TCP
      port: 80
      targetPort: 8080
```

## Monitoring with CloudWatch

```bash
#!/bin/bash
# Pull key ALB metrics for the last 5 minutes
ALB_SUFFIX="app/production-alb/abcd1234567890ef"
START_TIME=$(date -u -d '5 minutes ago' +%Y-%m-%dT%H:%M:%SZ)
END_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)

for METRIC in RequestCount HTTPCode_Target_5XX_Count TargetResponseTime HealthyHostCount UnHealthyHostCount; do
  echo "=== ${METRIC} ==="
  aws cloudwatch get-metric-statistics \
    --namespace AWS/ApplicationELB \
    --metric-name "${METRIC}" \
    --dimensions Name=LoadBalancer,Value="${ALB_SUFFIX}" \
    --start-time "${START_TIME}" \
    --end-time "${END_TIME}" \
    --period 300 \
    --statistics Sum Average Maximum \
    --output table
done
```

### Container Insights integration

```yaml
# PodMonitor for Kubernetes-native metrics
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: aws-lbc-metrics
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: aws-load-balancer-controller
  namespaceSelector:
    matchNames:
      - kube-system
  endpoints:
    - port: metrics-server
      interval: 30s
      path: /metrics
---
# Alert on controller reconcile errors
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: aws-lbc-alerts
  namespace: monitoring
spec:
  groups:
    - name: aws-lbc
      rules:
        - alert: LBCReconcileError
          expr: |
            rate(controller_runtime_reconcile_errors_total{controller=~"ingress|service"}[5m]) > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "AWS LBC reconcile errors for {{ $labels.controller }}"

        - alert: LBCHighReconcileDuration
          expr: |
            histogram_quantile(0.99,
              rate(controller_runtime_reconcile_time_seconds_bucket[5m])
            ) > 30
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "AWS LBC p99 reconcile time above 30s"
```

## Cost Optimization with Shared ALBs

The primary cost lever for AWS LBC deployments is ALB consolidation. Each ALB costs approximately $0.008/LCU-hour plus $0.0225/hour fixed. At 50 microservices with independent ALBs, the fixed cost alone exceeds $27/day.

```bash
#!/bin/bash
# Audit current ALB count and estimate savings
echo "=== Current ALB inventory ==="
aws elbv2 describe-load-balancers \
  --query 'LoadBalancers[?Type==`application`].[LoadBalancerName,DNSName]' \
  --output table

ALB_COUNT=$(aws elbv2 describe-load-balancers \
  --query 'length(LoadBalancers[?Type==`application`])' \
  --output text)

MONTHLY_FIXED_COST=$(echo "scale=2; ${ALB_COUNT} * 0.0225 * 24 * 30" | bc)
echo ""
echo "ALBs in use: ${ALB_COUNT}"
echo "Monthly fixed cost: \$${MONTHLY_FIXED_COST}"
echo ""
echo "=== Ingresses without group.name annotation ==="
kubectl get ingress --all-namespaces \
  -o jsonpath='{range .items[*]}{.metadata.namespace}{"\t"}{.metadata.name}{"\t"}{.metadata.annotations.alb\.ingress\.kubernetes\.io/group\.name}{"\n"}{end}' \
  | awk '$3==""'
```

The recommended consolidation strategy groups Ingresses by environment and team:

```yaml
# Add group.name to existing Ingresses without recreating the ALB
# The controller will merge rules into the shared ALB and clean up the old one
kubectl annotate ingress -n app-team-a api-ingress \
  alb.ingress.kubernetes.io/group.name=production-shared \
  alb.ingress.kubernetes.io/group.order=10 \
  --overwrite
```

## Troubleshooting

```bash
# View controller logs with increased verbosity
kubectl -n kube-system logs -l app.kubernetes.io/name=aws-load-balancer-controller \
  --follow --tail=100

# Check Ingress events for provisioning failures
kubectl -n app-team-a describe ingress api-ingress

# List all managed TargetGroups
aws elbv2 describe-target-groups \
  --query 'TargetGroups[?contains(TargetGroupName, `k8s-`)].[TargetGroupName,TargetGroupArn,TargetType]' \
  --output table

# Check target health for a specific service
TG_ARN=$(aws elbv2 describe-target-groups \
  --query 'TargetGroups[?contains(TargetGroupName, `k8s-appteama-apibackend`)].TargetGroupArn' \
  --output text)
aws elbv2 describe-target-health \
  --target-group-arn "${TG_ARN}" \
  --output table

# Verify IRSA is working correctly
kubectl -n kube-system exec -it \
  deploy/aws-load-balancer-controller -- \
  aws sts get-caller-identity

# Force re-reconciliation of a stuck Ingress
kubectl -n app-team-a annotate ingress api-ingress \
  alb.ingress.kubernetes.io/reconcile="$(date +%s)" \
  --overwrite
```

### Common error patterns

| Symptom | Likely cause | Resolution |
|---|---|---|
| `target.NotFound` in events | IRSA role missing `elasticloadbalancing:*` | Re-attach IAM policy |
| Ingress stuck in provisioning | Subnet missing `kubernetes.io/role/elb` tag | Tag subnets |
| Targets showing `unhealthy` | Health check path returning non-2xx | Adjust `healthcheck-path` annotation |
| 504 from ALB | Target deregistration too fast | Increase `deregistration_delay` |
| Cross-namespace cert reference fails | Missing RBAC for LBC to read Secrets | Check LBC ClusterRole |

## Preserving Client Source IP

For IP-mode NLB targets, the client source IP is preserved natively. For ALB with IP mode, the real IP is in the `X-Forwarded-For` header. Configure application servers to read this header:

```yaml
# Configure nginx Deployment to use X-Forwarded-For as real IP
apiVersion: v1
kind: ConfigMap
metadata:
  name: nginx-config
  namespace: app-team-a
data:
  nginx.conf: |
    set_real_ip_from 10.0.0.0/8;
    real_ip_header X-Forwarded-For;
    real_ip_recursive on;
    log_format main '$remote_addr - $http_x_forwarded_for [$time_local] '
                    '"$request" $status $body_bytes_sent';
```

For NLB with `preserve_client_ip.enabled=true` and `externalTrafficPolicy: Local`, pods receive the original client IP directly in the TCP connection without any header manipulation. This requires enough pod replicas per AZ to avoid `externalTrafficPolicy: Local` causing imbalanced traffic distribution.

```bash
# Verify client IP preservation on NLB targets
TG_ARN=$(aws elbv2 describe-target-groups \
  --query 'TargetGroups[?contains(TargetGroupName, `k8s-appteama-tcpapp`)].TargetGroupArn' \
  --output text)

aws elbv2 describe-target-group-attributes \
  --target-group-arn "${TG_ARN}" \
  --query 'Attributes[?Key==`preserve_client_ip.enabled`]'
```

## IngressClassParams for Cluster-Wide Defaults

**IngressClassParams** allows platform teams to define defaults that all Ingresses in the cluster inherit, reducing per-Ingress annotation boilerplate.

```yaml
apiVersion: elbv2.k8s.aws/v1beta1
kind: IngressClassParams
metadata:
  name: internal-alb-params
spec:
  scheme: internal
  ipAddressType: ipv4
  group:
    name: internal-shared
  loadBalancerAttributes:
    - key: idle_timeout.timeout_seconds
      value: "120"
    - key: routing.http.drop_invalid_header_fields.enabled
      value: "true"
    - key: access_logs.s3.enabled
      value: "true"
    - key: access_logs.s3.bucket
      value: "company-internal-alb-logs"
    - key: access_logs.s3.prefix
      value: "internal"
---
apiVersion: networking.k8s.io/v1
kind: IngressClass
metadata:
  name: alb-internal
spec:
  controller: ingress.k8s.aws/alb
  parameters:
    apiGroup: elbv2.k8s.aws
    kind: IngressClassParams
    name: internal-alb-params
```

Teams creating internal service Ingresses only need to specify `ingressClassName: alb-internal` and all defaults are applied automatically.

The AWS Load Balancer Controller provides a powerful bridge between Kubernetes-native resource definitions and AWS infrastructure. By leveraging IngressGroups for ALB consolidation, IP target mode for performance, and TargetGroupBinding for advanced deployment patterns, teams can achieve both cost efficiency and operational flexibility in their EKS environments.
