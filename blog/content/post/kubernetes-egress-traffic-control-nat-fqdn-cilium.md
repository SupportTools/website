---
title: "Kubernetes Egress Traffic Control: NAT Gateways, FQDN Policies, and Cilium Egress"
date: 2029-02-06T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Networking", "Cilium", "Security", "Egress", "CNI"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to controlling Kubernetes egress traffic using AWS NAT gateways, Cilium FQDN network policies, and CiliumEgressGatewayPolicy for predictable source IP addresses and fine-grained outbound access control."
more_link: "yes"
url: "/kubernetes-egress-traffic-control-nat-fqdn-cilium/"
---

Kubernetes ingress traffic control is well-covered by Ingress controllers and service mesh policies. Egress — traffic leaving the cluster to external services — is frequently an afterthought until a security audit flags unrestricted outbound access or a partner demands a fixed IP allowlist. At that point, retrofitting egress control onto an existing cluster without downtime requires a clear understanding of the available mechanisms and their interaction.

This guide covers three complementary egress control layers: NAT gateway configuration for predictable source IP addresses on cloud platforms, Cilium FQDN-based egress policies for DNS-resolved hostname restrictions, and CiliumEgressGatewayPolicy for pinning specific workloads to specific egress nodes with dedicated elastic IPs.

<!--more-->

## Egress Traffic Architecture

Kubernetes egress traffic follows a path that varies by CNI plugin and cloud provider:

```
Pod → Node network namespace → CNI (masquerade/NAT) → Cloud routing → Internet
```

Without intervention, egress traffic appears to external services as originating from the node's primary interface IP — which changes as nodes are replaced. Enterprise integrations requiring fixed IPs, PCI DSS scoped systems, and SaaS integrations with IP allowlists all require predictable egress IPs.

Three mechanisms address this:

1. **Cloud NAT gateway**: All egress traffic exits through a fixed NAT gateway IP. Simple but provides no per-service control.
2. **FQDN network policies**: Allow or deny connections to specific hostnames, regardless of their IP addresses.
3. **Egress gateway**: Specific pods route through dedicated nodes with static elastic IPs — most control, most complexity.

## AWS NAT Gateway Configuration

On AWS EKS, routing all pod egress through a NAT gateway ensures consistent source IPs for all outbound traffic.

```bash
# Verify current NAT gateway setup
aws ec2 describe-nat-gateways \
  --filter "Name=state,Values=available" \
  --query 'NatGateways[*].{ID:NatGatewayId,EIP:NatGatewayAddresses[0].PublicIp,VPC:VpcId,Subnet:SubnetId}' \
  --output table

# Check route tables for private subnets (where worker nodes live)
aws ec2 describe-route-tables \
  --filters "Name=association.subnet-id,Values=subnet-0abc12345678def90" \
  --query 'RouteTables[*].Routes[?GatewayId!=`local`]'

# Add NAT gateway route to private subnet route table if missing
aws ec2 create-route \
  --route-table-id rtb-0abc12345def67890 \
  --destination-cidr-block 0.0.0.0/0 \
  --nat-gateway-id nat-0abc12345def67890

# Verify pod egress IP from within a pod
kubectl run egress-test --image=curlimages/curl:8.5.0 --restart=Never \
  --command -- curl -s https://api.ipify.org
kubectl logs egress-test
# Should return the NAT gateway's Elastic IP address
kubectl delete pod egress-test
```

### Terraform Configuration for Predictable NAT

```hcl
# terraform/modules/vpc/main.tf

# Elastic IPs for NAT gateways (one per AZ for HA)
resource "aws_eip" "nat" {
  count  = length(var.availability_zones)
  domain = "vpc"

  tags = {
    Name        = "nat-${var.cluster_name}-${var.availability_zones[count.index]}"
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# NAT Gateways in public subnets
resource "aws_nat_gateway" "main" {
  count         = length(var.availability_zones)
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id

  depends_on = [aws_internet_gateway.main]

  tags = {
    Name        = "nat-${var.cluster_name}-${var.availability_zones[count.index]}"
    Environment = var.environment
  }
}

# Private subnet route tables: route egress through NAT
resource "aws_route" "private_nat" {
  count                  = length(var.availability_zones)
  route_table_id         = aws_route_table.private[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.main[count.index].id
}

output "nat_gateway_ips" {
  description = "Elastic IPs of NAT gateways — provide these to external service allowlists"
  value       = aws_eip.nat[*].public_ip
}
```

## Cilium FQDN-Based Egress Policies

Standard Kubernetes NetworkPolicy only supports IP CIDR-based rules, which are useless for cloud services whose IPs change continuously (AWS API endpoints, Stripe, Twilio, etc.). Cilium's FQDN policies resolve hostnames in real-time and apply network policy to the resolved IPs.

### Default-Deny Egress Policy

Start with a default-deny policy per namespace, then explicitly allow required external services.

```yaml
# Deny all egress from the payments namespace by default
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: default-deny-egress
  namespace: payments
spec:
  endpointSelector: {}  # applies to all pods in namespace
  egress:
    # Allow DNS resolution (required for FQDN policies to work)
    - toEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: kube-system
            k8s-app: kube-dns
      toPorts:
        - ports:
            - port: "53"
              protocol: UDP
            - port: "53"
              protocol: TCP
    # Allow communication within the cluster
    - toEntities:
        - cluster
    # Allow communication within the same namespace
    - toEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: payments
```

### FQDN-Based Allowlist Policies

```yaml
# Allow payments-api to reach Stripe API
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: payments-api-egress-stripe
  namespace: payments
spec:
  endpointSelector:
    matchLabels:
      app: payments-api
  egress:
    - toFQDNs:
        # Stripe API endpoints
        - matchName: "api.stripe.com"
        - matchName: "files.stripe.com"
        - matchPattern: "*.stripe.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP
    - toFQDNs:
        # AWS services used by the payments service
        - matchName: "secretsmanager.us-east-1.amazonaws.com"
        - matchName: "kms.us-east-1.amazonaws.com"
        - matchName: "s3.amazonaws.com"
        - matchPattern: "*.s3.amazonaws.com"
        - matchPattern: "*.s3.us-east-1.amazonaws.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP
    - toFQDNs:
        # Internal services accessible externally
        - matchName: "vault.platform.internal"
      toPorts:
        - ports:
            - port: "8200"
              protocol: TCP
---
# Allow workers to reach Kafka MSK
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: payments-worker-egress-kafka
  namespace: payments
spec:
  endpointSelector:
    matchLabels:
      app: payments-worker
  egress:
    - toFQDNs:
        - matchPattern: "b-*.kafka.us-east-1.amazonaws.com"
        - matchPattern: "boot*.kafka.us-east-1.amazonaws.com"
      toPorts:
        - ports:
            - port: "9094"
              protocol: TCP
            - port: "9096"
              protocol: TCP
    - toFQDNs:
        - matchName: "schema-registry.platform.internal"
      toPorts:
        - ports:
            - port: "8081"
              protocol: TCP
```

### DNS Inspection Configuration

For FQDN policies to work, Cilium must intercept DNS responses to learn IP-to-FQDN mappings.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: cilium-config
  namespace: kube-system
data:
  # Enable DNS proxy for FQDN policies
  enable-policy: "default"
  enable-dns-proxy: "true"

  # Proxy all DNS requests through Cilium's DNS proxy
  # Required for FQDN policy enforcement
  dns-proxy-response-max-delay: "100ms"

  # Cache DNS resolutions for this long
  # Set to match your DNS TTL — too high misses IP changes, too low causes policy churn
  tofqdns-dns-reject-response-code: "refused"
  tofqdns-enable-poller: "true"
  tofqdns-max-deferred-connection-deletes: "10000"
  tofqdns-min-ttl: "3600"
```

## Cilium Egress Gateway Policy

The EgressGatewayPolicy routes specific pod traffic through dedicated egress nodes that have fixed Elastic IP addresses. This is the surgical approach: only sensitive workloads (payment processing, external API calls to partners requiring IP allowlisting) use the dedicated egress path.

### Egress Gateway Node Setup

```bash
# Label dedicated egress nodes
kubectl label nodes ip-10-0-1-100.ec2.internal egress-gateway=payments
kubectl label nodes ip-10-0-2-100.ec2.internal egress-gateway=payments

# These nodes must have an Elastic IP attached in AWS
# Assign EIP to the ENI of the egress node
INSTANCE_ID=$(aws ec2 describe-instances \
  --filters "Name=private-dns-name,Values=ip-10-0-1-100.ec2.internal" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)

EIP_ALLOC=$(aws ec2 allocate-address --domain vpc \
  --query 'AllocationId' --output text)

aws ec2 associate-address \
  --instance-id "$INSTANCE_ID" \
  --allocation-id "$EIP_ALLOC"
```

### CiliumEgressGatewayPolicy

```yaml
apiVersion: cilium.io/v2
kind: CiliumEgressGatewayPolicy
metadata:
  name: payments-egress-via-dedicated-nodes
spec:
  selectors:
    # Apply to all pods in the payments namespace with egress-gateway annotation
    - podSelector:
        matchLabels:
          k8s:io.kubernetes.pod.namespace: payments
          egress-via-gateway: "true"

  destinationCIDRs:
    # Route to Stripe's published IP ranges
    - "3.18.12.63/32"
    - "3.130.192.231/32"
    - "13.235.14.237/32"
    - "18.211.135.69/32"
    - "52.15.183.38/32"
    - "54.187.174.169/32"
    # Or use a wildcard for all external traffic
    # - "0.0.0.0/0"
    # Exclude cluster-internal traffic
    # excludedCIDRs:
    #   - "10.0.0.0/8"
    #   - "172.16.0.0/12"

  egressGateway:
    nodeSelector:
      matchLabels:
        egress-gateway: payments
    egressIP: "203.0.113.45"  # The EIP attached to the egress node
```

Enable egress gateway on specific pods:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payments-api
  namespace: payments
spec:
  template:
    metadata:
      labels:
        app: payments-api
        egress-via-gateway: "true"  # Routes egress through dedicated node
```

## Monitoring Egress Policy Enforcement

```bash
# Check FQDN policy state in Cilium
kubectl exec -n kube-system -l k8s-app=cilium -c cilium-agent \
  -- cilium policy get

# Show resolved FQDNs and their IPs
kubectl exec -n kube-system -l k8s-app=cilium -c cilium-agent \
  -- cilium fqdn cache list

# Check which IPs are allowed for a specific endpoint
kubectl exec -n kube-system -l k8s-app=cilium -c cilium-agent \
  -- cilium endpoint list

# Get endpoint ID for a specific pod
POD_IP=$(kubectl get pod -n payments payments-api-xxxxx -o jsonpath='{.status.podIP}')
kubectl exec -n kube-system -l k8s-app=cilium -c cilium-agent \
  -- cilium endpoint list | grep "$POD_IP"

# Check policy for specific endpoint
ENDPOINT_ID=1234  # from above command
kubectl exec -n kube-system -l k8s-app=cilium -c cilium-agent \
  -- cilium endpoint get "$ENDPOINT_ID" -o json | jq '.spec.policy'

# Monitor dropped packets in real time
kubectl exec -n kube-system -l k8s-app=cilium -c cilium-agent \
  -- cilium monitor --type drop --from-endpoint "$ENDPOINT_ID"

# Check egress gateway policy status
kubectl get CiliumEgressGatewayPolicy -A
kubectl describe CiliumEgressGatewayPolicy payments-egress-via-dedicated-nodes
```

### Prometheus Metrics for Egress Monitoring

```yaml
# ServiceMonitor for Cilium metrics
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: cilium-agent
  namespace: kube-system
spec:
  selector:
    matchLabels:
      k8s-app: cilium
  endpoints:
    - port: prometheus
      interval: 30s
      path: /metrics
---
# Alerting rules
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: egress-policy-alerts
  namespace: monitoring
spec:
  groups:
    - name: egress
      rules:
        - alert: EgressPolicyDropRate
          expr: |
            rate(cilium_drop_count_total{reason="Policy denied"}[5m]) > 100
          for: 2m
          labels:
            severity: warning
          annotations:
            summary: "High egress policy drop rate: {{ $value }} drops/sec"
            description: "More than 100 packets/sec dropped by egress policy — may indicate misconfigured policy or attempted unauthorized access"

        - alert: FQDNPolicyResolutionFailure
          expr: |
            rate(cilium_dns_proxy_responses_total{returnCode="SERVFAIL"}[5m]) > 10
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "FQDN policy DNS resolution failures: {{ $value }}/sec"
```

## Testing Egress Policies

```bash
# Test that payments-api can reach Stripe
kubectl exec -n payments deployment/payments-api -- \
  curl -I --max-time 5 https://api.stripe.com/v1/charges

# Test that payments-api cannot reach unauthorized external hosts
kubectl exec -n payments deployment/payments-api -- \
  curl -I --max-time 5 https://api.example-unauthorized-service.com
# Expected: connection timeout or connection refused

# Test that payments-worker can reach Kafka but not Stripe
kubectl exec -n payments deployment/payments-worker -- \
  curl -I --max-time 5 https://api.stripe.com/v1/charges
# Expected: denied by policy

# Verify egress IP when routing through gateway
kubectl exec -n payments deployment/payments-api -- \
  curl -s https://api.ipify.org
# Expected: 203.0.113.45 (the EIP attached to the egress gateway node)

# Compare: pod WITHOUT egress-via-gateway label should use NAT gateway IP
kubectl run no-gateway-test \
  --image=curlimages/curl:8.5.0 \
  --namespace payments \
  --labels="app=test-no-gateway" \
  --restart=Never \
  --command -- curl -s https://api.ipify.org
kubectl logs -n payments no-gateway-test
# Expected: NAT gateway IP (different from EIP above)
kubectl delete pod -n payments no-gateway-test
```

## Cilium CLI Audit Tools

```bash
# Install Cilium CLI
CILIUM_CLI_VERSION=$(curl -s https://raw.githubusercontent.com/cilium/cilium-cli/main/stable.txt)
curl -L --fail --remote-name-all \
  "https://github.com/cilium/cilium-cli/releases/download/${CILIUM_CLI_VERSION}/cilium-linux-amd64.tar.gz"
tar xzvf cilium-linux-amd64.tar.gz
mv cilium /usr/local/bin

# Check Cilium health
cilium status --wait

# Run connectivity test (validates policies do not break cluster communication)
cilium connectivity test --namespace cilium-test

# Audit all endpoints and their policy state
kubectl exec -n kube-system -l k8s-app=cilium -c cilium-agent \
  -- cilium endpoint list -o json | \
  jq '.[] | {id: .id, labels: .status.labels.realized."any:app", policyEnabled: .status.policy."policy-enabled"}'

# Generate a policy enforcement report
kubectl exec -n kube-system -l k8s-app=cilium -c cilium-agent \
  -- cilium policy trace \
    --src-k8s-pod payments/payments-api-xxxxx \
    --dst-ip 52.15.183.38 \
    --dport 443/TCP
```

Combining NAT gateways for predictable egress IPs, FQDN policies for application-layer DNS-resolved access control, and CiliumEgressGatewayPolicy for workloads requiring dedicated IPs provides defense-in-depth egress control that satisfies security audits and partner IP allowlist requirements while maintaining operational observability through Prometheus metrics and Cilium's built-in policy tracing tools.
