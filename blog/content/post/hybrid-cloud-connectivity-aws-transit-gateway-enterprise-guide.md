---
title: "Hybrid Cloud Connectivity with AWS Transit Gateway: Enterprise Architecture Guide"
date: 2026-08-05T00:00:00-05:00
draft: false
tags: ["AWS", "Transit Gateway", "Hybrid Cloud", "Networking", "VPC", "VPN", "Direct Connect", "Cloud Architecture"]
categories: ["Cloud Infrastructure", "Networking", "AWS"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to building enterprise hybrid cloud connectivity using AWS Transit Gateway, including VPC peering, VPN connections, Direct Connect integration, and advanced routing patterns."
more_link: "yes"
url: "/hybrid-cloud-connectivity-aws-transit-gateway-enterprise-guide/"
---

Hybrid cloud architectures require robust, scalable networking solutions that can connect on-premises data centers with cloud resources while maintaining security, performance, and manageability. AWS Transit Gateway provides a centralized hub for managing network connectivity across multiple VPCs, regions, and hybrid environments. This comprehensive guide explores enterprise-grade hybrid cloud connectivity patterns using Transit Gateway.

<!--more-->

## Understanding AWS Transit Gateway Architecture

### Core Concepts

AWS Transit Gateway acts as a cloud router that connects VPCs and on-premises networks through a central hub. It simplifies network architecture by eliminating the need for complex peering relationships and reducing the number of connections required.

#### Key Components

```text
Transit Gateway Architecture:

                    ┌─────────────────┐
                    │   Transit GW    │
                    │   (Regional)    │
                    └────────┬────────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
    ┌────▼────┐         ┌────▼────┐         ┌───▼────┐
    │  VPC 1  │         │  VPC 2  │         │  VPN   │
    │  App    │         │  Data   │         │Connection│
    └─────────┘         └─────────┘         └───┬────┘
                                                 │
                                          ┌──────▼──────┐
                                          │  On-Premises│
                                          │  Data Center│
                                          └─────────────┘
```

### Transit Gateway Benefits

**Centralized Management:**
- Single point of network control
- Simplified routing policies
- Consistent security policies
- Reduced operational complexity

**Scalability:**
- Up to 5,000 VPC attachments per gateway
- 50 Gbps bandwidth per VPC attachment
- Support for thousands of routes
- Multi-region peering

**Cost Optimization:**
- Reduced NAT Gateway costs
- Consolidated VPN connections
- Efficient bandwidth utilization
- Pay-per-use pricing model

## Deploying Transit Gateway Infrastructure

### Terraform Configuration

#### Transit Gateway Base Setup

```hcl
# variables.tf
variable "environment" {
  description = "Environment name"
  type        = string
  default     = "production"
}

variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "enable_dns_support" {
  description = "Enable DNS support for Transit Gateway"
  type        = bool
  default     = true
}

variable "enable_vpn_ecmp_support" {
  description = "Enable ECMP for VPN connections"
  type        = bool
  default     = true
}

variable "default_route_table_association" {
  description = "Enable default route table association"
  type        = bool
  default     = false
}

variable "default_route_table_propagation" {
  description = "Enable default route table propagation"
  type        = bool
  default     = false
}

variable "on_premises_cidrs" {
  description = "On-premises network CIDRs"
  type        = list(string)
  default     = ["10.0.0.0/8", "172.16.0.0/12"]
}

# transit-gateway.tf
resource "aws_ec2_transit_gateway" "main" {
  description                     = "Main Transit Gateway for ${var.environment}"
  amazon_side_asn                 = 64512
  default_route_table_association = var.default_route_table_association ? "enable" : "disable"
  default_route_table_propagation = var.default_route_table_propagation ? "enable" : "disable"
  dns_support                     = var.enable_dns_support ? "enable" : "disable"
  vpn_ecmp_support               = var.enable_vpn_ecmp_support ? "enable" : "disable"
  multicast_support              = "disable"
  auto_accept_shared_attachments = "disable"

  tags = {
    Name        = "tgw-${var.environment}"
    Environment = var.environment
    ManagedBy   = "Terraform"
    Purpose     = "Hybrid-Cloud-Connectivity"
  }
}

# Create custom route tables for segmentation
resource "aws_ec2_transit_gateway_route_table" "production" {
  transit_gateway_id = aws_ec2_transit_gateway.main.id

  tags = {
    Name        = "tgw-rt-production"
    Environment = "production"
    Tier        = "production"
  }
}

resource "aws_ec2_transit_gateway_route_table" "development" {
  transit_gateway_id = aws_ec2_transit_gateway.main.id

  tags = {
    Name        = "tgw-rt-development"
    Environment = "development"
    Tier        = "development"
  }
}

resource "aws_ec2_transit_gateway_route_table" "shared_services" {
  transit_gateway_id = aws_ec2_transit_gateway.main.id

  tags = {
    Name        = "tgw-rt-shared-services"
    Environment = var.environment
    Tier        = "shared-services"
  }
}

resource "aws_ec2_transit_gateway_route_table" "on_premises" {
  transit_gateway_id = aws_ec2_transit_gateway.main.id

  tags = {
    Name        = "tgw-rt-on-premises"
    Environment = var.environment
    Tier        = "on-premises"
  }
}

# outputs.tf
output "transit_gateway_id" {
  description = "Transit Gateway ID"
  value       = aws_ec2_transit_gateway.main.id
}

output "transit_gateway_arn" {
  description = "Transit Gateway ARN"
  value       = aws_ec2_transit_gateway.main.arn
}

output "transit_gateway_route_table_ids" {
  description = "Transit Gateway route table IDs"
  value = {
    production      = aws_ec2_transit_gateway_route_table.production.id
    development     = aws_ec2_transit_gateway_route_table.development.id
    shared_services = aws_ec2_transit_gateway_route_table.shared_services.id
    on_premises     = aws_ec2_transit_gateway_route_table.on_premises.id
  }
}
```

### VPC Attachments Configuration

#### Production VPC Attachment

```hcl
# vpc-attachments.tf
data "aws_vpc" "production" {
  filter {
    name   = "tag:Environment"
    values = ["production"]
  }
}

data "aws_subnets" "production_private" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.production.id]
  }

  filter {
    name   = "tag:Tier"
    values = ["private"]
  }
}

resource "aws_ec2_transit_gateway_vpc_attachment" "production" {
  subnet_ids         = data.aws_subnets.production_private.ids
  transit_gateway_id = aws_ec2_transit_gateway.main.id
  vpc_id             = data.aws_vpc.production.id

  dns_support                                     = "enable"
  ipv6_support                                    = "disable"
  appliance_mode_support                          = "disable"
  transit_gateway_default_route_table_association = false
  transit_gateway_default_route_table_propagation = false

  tags = {
    Name        = "tgw-attach-production-vpc"
    Environment = "production"
    VPC         = data.aws_vpc.production.id
  }
}

# Associate with production route table
resource "aws_ec2_transit_gateway_route_table_association" "production" {
  transit_gateway_attachment_id  = aws_ec2_transit_gateway_vpc_attachment.production.id
  transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table.production.id
}

# Propagate production routes to on-premises route table
resource "aws_ec2_transit_gateway_route_table_propagation" "production_to_on_premises" {
  transit_gateway_attachment_id  = aws_ec2_transit_gateway_vpc_attachment.production.id
  transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table.on_premises.id
}

# Propagate production routes to shared services route table
resource "aws_ec2_transit_gateway_route_table_propagation" "production_to_shared" {
  transit_gateway_attachment_id  = aws_ec2_transit_gateway_vpc_attachment.production.id
  transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table.shared_services.id
}

# Update VPC route tables to route through Transit Gateway
data "aws_route_tables" "production_private" {
  vpc_id = data.aws_vpc.production.id

  filter {
    name   = "tag:Tier"
    values = ["private"]
  }
}

resource "aws_route" "production_to_on_premises" {
  count = length(data.aws_route_tables.production_private.ids)

  route_table_id         = data.aws_route_tables.production_private.ids[count.index]
  destination_cidr_block = var.on_premises_cidrs[0]
  transit_gateway_id     = aws_ec2_transit_gateway.main.id

  depends_on = [aws_ec2_transit_gateway_vpc_attachment.production]
}

resource "aws_route" "production_to_shared_services" {
  count = length(data.aws_route_tables.production_private.ids)

  route_table_id         = data.aws_route_tables.production_private.ids[count.index]
  destination_cidr_block = "100.64.0.0/16" # Shared services CIDR
  transit_gateway_id     = aws_ec2_transit_gateway.main.id

  depends_on = [aws_ec2_transit_gateway_vpc_attachment.production]
}
```

## VPN Connection Configuration

### Site-to-Site VPN Setup

#### Customer Gateway Configuration

```hcl
# customer-gateway.tf
variable "customer_gateway_ip" {
  description = "On-premises VPN endpoint public IP"
  type        = string
}

variable "customer_gateway_bgp_asn" {
  description = "BGP ASN for customer gateway"
  type        = number
  default     = 65000
}

resource "aws_customer_gateway" "main" {
  bgp_asn    = var.customer_gateway_bgp_asn
  ip_address = var.customer_gateway_ip
  type       = "ipsec.1"

  tags = {
    Name        = "cgw-${var.environment}-main"
    Environment = var.environment
    Location    = "on-premises-dc1"
  }
}

# VPN connection with ECMP support (two tunnels)
resource "aws_vpn_connection" "main" {
  customer_gateway_id = aws_customer_gateway.main.id
  transit_gateway_id  = aws_ec2_transit_gateway.main.id
  type                = aws_customer_gateway.main.type

  static_routes_only = false # Use BGP for dynamic routing

  tunnel1_inside_cidr   = "169.254.10.0/30"
  tunnel1_preshared_key = random_password.tunnel1_psk.result

  tunnel2_inside_cidr   = "169.254.10.4/30"
  tunnel2_preshared_key = random_password.tunnel2_psk.result

  tunnel1_dpd_timeout_action = "restart"
  tunnel2_dpd_timeout_action = "restart"

  tunnel1_ike_versions = ["ikev2"]
  tunnel2_ike_versions = ["ikev2"]

  tunnel1_phase1_dh_group_numbers      = [14, 15, 16, 17, 18]
  tunnel1_phase1_encryption_algorithms = ["AES256", "AES128"]
  tunnel1_phase1_integrity_algorithms  = ["SHA2-256", "SHA2-384", "SHA2-512"]
  tunnel1_phase1_lifetime_seconds      = 28800

  tunnel2_phase1_dh_group_numbers      = [14, 15, 16, 17, 18]
  tunnel2_phase1_encryption_algorithms = ["AES256", "AES128"]
  tunnel2_phase1_integrity_algorithms  = ["SHA2-256", "SHA2-384", "SHA2-512"]
  tunnel2_phase1_lifetime_seconds      = 28800

  tunnel1_phase2_dh_group_numbers      = [14, 15, 16, 17, 18]
  tunnel1_phase2_encryption_algorithms = ["AES256", "AES128"]
  tunnel1_phase2_integrity_algorithms  = ["SHA2-256", "SHA2-384", "SHA2-512"]
  tunnel1_phase2_lifetime_seconds      = 3600

  tunnel2_phase2_dh_group_numbers      = [14, 15, 16, 17, 18]
  tunnel2_phase2_encryption_algorithms = ["AES256", "AES128"]
  tunnel2_phase2_integrity_algorithms  = ["SHA2-256", "SHA2-384", "SHA2-512"]
  tunnel2_phase2_lifetime_seconds      = 3600

  tags = {
    Name        = "vpn-${var.environment}-main"
    Environment = var.environment
  }
}

resource "random_password" "tunnel1_psk" {
  length  = 32
  special = true
}

resource "random_password" "tunnel2_psk" {
  length  = 32
  special = true
}

# Store VPN configuration in Secrets Manager
resource "aws_secretsmanager_secret" "vpn_config" {
  name        = "${var.environment}/vpn/main-connection"
  description = "VPN connection configuration for ${var.environment}"

  tags = {
    Environment = var.environment
    Purpose     = "VPN-Configuration"
  }
}

resource "aws_secretsmanager_secret_version" "vpn_config" {
  secret_id = aws_secretsmanager_secret.vpn_config.id
  secret_string = jsonencode({
    tunnel1 = {
      outside_ip_address = aws_vpn_connection.main.tunnel1_address
      inside_cidr        = aws_vpn_connection.main.tunnel1_inside_cidr
      preshared_key      = random_password.tunnel1_psk.result
      bgp_asn            = aws_vpn_connection.main.tunnel1_bgp_asn
      bgp_holdtime       = aws_vpn_connection.main.tunnel1_bgp_holdtime
    }
    tunnel2 = {
      outside_ip_address = aws_vpn_connection.main.tunnel2_address
      inside_cidr        = aws_vpn_connection.main.tunnel2_inside_cidr
      preshared_key      = random_password.tunnel2_psk.result
      bgp_asn            = aws_vpn_connection.main.tunnel2_bgp_asn
      bgp_holdtime       = aws_vpn_connection.main.tunnel2_bgp_holdtime
    }
    customer_gateway_ip = var.customer_gateway_ip
  })
}

# Attach VPN to Transit Gateway
resource "aws_ec2_transit_gateway_route_table_association" "vpn" {
  transit_gateway_attachment_id  = aws_vpn_connection.main.transit_gateway_attachment_id
  transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table.on_premises.id
}

# Propagate VPN routes to production and shared services
resource "aws_ec2_transit_gateway_route_table_propagation" "vpn_to_production" {
  transit_gateway_attachment_id  = aws_vpn_connection.main.transit_gateway_attachment_id
  transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table.production.id
}

resource "aws_ec2_transit_gateway_route_table_propagation" "vpn_to_shared" {
  transit_gateway_attachment_id  = aws_vpn_connection.main.transit_gateway_attachment_id
  transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table.shared_services.id
}
```

### On-Premises VPN Configuration (StrongSwan)

```bash
#!/bin/bash
# configure-strongswan.sh - Configure StrongSwan for AWS VPN

set -euo pipefail

# Retrieve VPN configuration from AWS Secrets Manager
VPN_CONFIG=$(aws secretsmanager get-secret-value \
  --secret-id production/vpn/main-connection \
  --query SecretString \
  --output text)

TUNNEL1_OUTSIDE_IP=$(echo "$VPN_CONFIG" | jq -r '.tunnel1.outside_ip_address')
TUNNEL1_INSIDE_CIDR=$(echo "$VPN_CONFIG" | jq -r '.tunnel1.inside_cidr')
TUNNEL1_PSK=$(echo "$VPN_CONFIG" | jq -r '.tunnel1.preshared_key')
TUNNEL1_BGP_ASN=$(echo "$VPN_CONFIG" | jq -r '.tunnel1.bgp_asn')

TUNNEL2_OUTSIDE_IP=$(echo "$VPN_CONFIG" | jq -r '.tunnel2.outside_ip_address')
TUNNEL2_INSIDE_CIDR=$(echo "$VPN_CONFIG" | jq -r '.tunnel2.inside_cidr')
TUNNEL2_PSK=$(echo "$VPN_CONFIG" | jq -r '.tunnel2.preshared_key')
TUNNEL2_BGP_ASN=$(echo "$VPN_CONFIG" | jq -r '.tunnel2.bgp_asn')

LOCAL_IP=$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4)
LOCAL_BGP_ASN="65000"

# Configure StrongSwan
cat > /etc/ipsec.conf <<EOF
config setup
    charondebug="ike 2, knl 2, cfg 2, net 2, esp 2, dmn 2, mgr 2"
    strictcrlpolicy=no
    uniqueids=no

# Tunnel 1
conn aws-tunnel1
    auto=start
    left=%defaultroute
    leftid=$LOCAL_IP
    right=$TUNNEL1_OUTSIDE_IP
    type=tunnel
    ikelifetime=8h
    keylife=1h
    rekeymargin=3m
    keyingtries=%forever
    keyexchange=ikev2
    ike=aes256-sha256-modp2048,aes128-sha256-modp2048!
    esp=aes256-sha256-modp2048,aes128-sha256-modp2048!
    leftsubnet=0.0.0.0/0
    rightsubnet=0.0.0.0/0
    dpddelay=10s
    dpdtimeout=30s
    dpdaction=restart
    mark=%unique

# Tunnel 2
conn aws-tunnel2
    auto=start
    left=%defaultroute
    leftid=$LOCAL_IP
    right=$TUNNEL2_OUTSIDE_IP
    type=tunnel
    ikelifetime=8h
    keylife=1h
    rekeymargin=3m
    keyingtries=%forever
    keyexchange=ikev2
    ike=aes256-sha256-modp2048,aes128-sha256-modp2048!
    esp=aes256-sha256-modp2048,aes128-sha256-modp2048!
    leftsubnet=0.0.0.0/0
    rightsubnet=0.0.0.0/0
    dpddelay=10s
    dpdtimeout=30s
    dpdaction=restart
    mark=%unique
EOF

# Configure PSKs
cat > /etc/ipsec.secrets <<EOF
$LOCAL_IP $TUNNEL1_OUTSIDE_IP : PSK "$TUNNEL1_PSK"
$LOCAL_IP $TUNNEL2_OUTSIDE_IP : PSK "$TUNNEL2_PSK"
EOF

chmod 600 /etc/ipsec.secrets

# Configure BGP with FRRouting
TUNNEL1_LOCAL_IP=$(echo "$TUNNEL1_INSIDE_CIDR" | cut -d'/' -f1 | awk -F. '{print $1"."$2"."$3"."$4+1}')
TUNNEL1_PEER_IP=$(echo "$TUNNEL1_INSIDE_CIDR" | cut -d'/' -f1 | awk -F. '{print $1"."$2"."$3"."$4+2}')
TUNNEL2_LOCAL_IP=$(echo "$TUNNEL2_INSIDE_CIDR" | cut -d'/' -f1 | awk -F. '{print $1"."$2"."$3"."$4+1}')
TUNNEL2_PEER_IP=$(echo "$TUNNEL2_INSIDE_CIDR" | cut -d'/' -f1 | awk -F. '{print $1"."$2"."$3"."$4+2}')

cat > /etc/frr/frr.conf <<EOF
frr version 8.0
frr defaults traditional
hostname vpn-gateway
log syslog informational
service integrated-vtysh-config

# Configure BGP
router bgp $LOCAL_BGP_ASN
 bgp router-id $LOCAL_IP
 bgp log-neighbor-changes
 no bgp default ipv4-unicast

 # Tunnel 1 neighbor
 neighbor $TUNNEL1_PEER_IP remote-as $TUNNEL1_BGP_ASN
 neighbor $TUNNEL1_PEER_IP timers 10 30 30

 # Tunnel 2 neighbor
 neighbor $TUNNEL2_PEER_IP remote-as $TUNNEL2_BGP_ASN
 neighbor $TUNNEL2_PEER_IP timers 10 30 30

 address-family ipv4 unicast
  network 10.0.0.0/8
  network 172.16.0.0/12

  neighbor $TUNNEL1_PEER_IP activate
  neighbor $TUNNEL1_PEER_IP soft-reconfiguration inbound
  neighbor $TUNNEL1_PEER_IP route-map AWS-IN in
  neighbor $TUNNEL1_PEER_IP route-map AWS-OUT out

  neighbor $TUNNEL2_PEER_IP activate
  neighbor $TUNNEL2_PEER_IP soft-reconfiguration inbound
  neighbor $TUNNEL2_PEER_IP route-map AWS-IN in
  neighbor $TUNNEL2_PEER_IP route-map AWS-OUT out
 exit-address-family

# Route maps for traffic engineering
route-map AWS-IN permit 10
 set local-preference 100

route-map AWS-OUT permit 10
 match ip address prefix-list ADVERTISE-TO-AWS

# Prefix lists
ip prefix-list ADVERTISE-TO-AWS seq 10 permit 10.0.0.0/8
ip prefix-list ADVERTISE-TO-AWS seq 20 permit 172.16.0.0/12

line vty
EOF

# Restart services
systemctl restart strongswan-starter
systemctl restart frr

echo "VPN configuration completed successfully"
```

## AWS Direct Connect Integration

### Direct Connect Gateway Configuration

```hcl
# direct-connect.tf
variable "direct_connect_gateway_asn" {
  description = "BGP ASN for Direct Connect Gateway"
  type        = number
  default     = 64513
}

variable "allowed_prefixes" {
  description = "Allowed prefixes for Direct Connect"
  type        = list(string)
  default     = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]
}

# Direct Connect Gateway
resource "aws_dx_gateway" "main" {
  name            = "dxgw-${var.environment}"
  amazon_side_asn = var.direct_connect_gateway_asn
}

# Associate Direct Connect Gateway with Transit Gateway
resource "aws_dx_gateway_association" "transit_gateway" {
  dx_gateway_id         = aws_dx_gateway.main.id
  associated_gateway_id = aws_ec2_transit_gateway.main.id

  allowed_prefixes = var.allowed_prefixes
}

# Virtual Interface (typically created by AWS or your carrier)
# This is a placeholder - actual VIF creation depends on your Direct Connect setup
resource "aws_dx_private_virtual_interface" "main" {
  connection_id = var.direct_connect_connection_id # Provided by your setup

  name           = "vif-${var.environment}-main"
  vlan           = 1000
  address_family = "ipv4"
  bgp_asn        = var.customer_gateway_bgp_asn

  # BGP configuration
  amazon_address   = "169.254.255.1/30"
  customer_address = "169.254.255.2/30"
  bgp_auth_key     = random_password.dx_bgp_key.result

  dx_gateway_id = aws_dx_gateway.main.id

  tags = {
    Name        = "vif-${var.environment}-main"
    Environment = var.environment
  }
}

resource "random_password" "dx_bgp_key" {
  length  = 32
  special = true
}

# Monitor Direct Connect connection status
resource "aws_cloudwatch_metric_alarm" "dx_connection_state" {
  alarm_name          = "dx-connection-state-${var.environment}"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "ConnectionState"
  namespace           = "AWS/DX"
  period              = 60
  statistic           = "Minimum"
  threshold           = 1
  alarm_description   = "Direct Connect connection is down"
  treat_missing_data  = "breaching"

  dimensions = {
    ConnectionId = var.direct_connect_connection_id
  }

  alarm_actions = [aws_sns_topic.network_alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "dx_connection_bps_egress" {
  alarm_name          = "dx-high-egress-${var.environment}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "ConnectionBpsEgress"
  namespace           = "AWS/DX"
  period              = 300
  statistic           = "Average"
  threshold           = 8000000000 # 8 Gbps for 10G connection
  alarm_description   = "Direct Connect egress bandwidth high"

  dimensions = {
    ConnectionId = var.direct_connect_connection_id
  }

  alarm_actions = [aws_sns_topic.network_alerts.arn]
}
```

## Advanced Routing Patterns

### Route Segmentation and Isolation

```hcl
# advanced-routing.tf

# Static routes for specific use cases
resource "aws_ec2_transit_gateway_route" "blackhole_suspicious_network" {
  destination_cidr_block         = "192.0.2.0/24" # Example: block suspicious network
  transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table.production.id
  blackhole                      = true
}

# Route to inspection VPC for security scanning
resource "aws_ec2_transit_gateway_route" "internet_to_inspection" {
  destination_cidr_block         = "0.0.0.0/0"
  transit_gateway_attachment_id  = aws_ec2_transit_gateway_vpc_attachment.inspection.id
  transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table.production.id
}

# Development environment isolation
resource "aws_ec2_transit_gateway_route" "dev_to_shared_services" {
  destination_cidr_block         = "100.64.0.0/16"
  transit_gateway_attachment_id  = aws_ec2_transit_gateway_vpc_attachment.shared_services.id
  transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table.development.id
}

# Block development from accessing production
# (No routes from dev route table to production VPC)

# Shared services access to all environments
resource "aws_ec2_transit_gateway_route_table_propagation" "shared_to_prod" {
  transit_gateway_attachment_id  = aws_ec2_transit_gateway_vpc_attachment.production.id
  transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table.shared_services.id
}

resource "aws_ec2_transit_gateway_route_table_propagation" "shared_to_dev" {
  transit_gateway_attachment_id  = aws_ec2_transit_gateway_vpc_attachment.development.id
  transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table.shared_services.id
}
```

### Traffic Inspection Architecture

```hcl
# inspection-vpc.tf
resource "aws_vpc" "inspection" {
  cidr_block           = "100.65.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name        = "vpc-inspection-${var.environment}"
    Environment = var.environment
    Purpose     = "Network-Inspection"
  }
}

# Deploy AWS Network Firewall
resource "aws_networkfirewall_firewall" "main" {
  name                = "nfw-${var.environment}"
  firewall_policy_arn = aws_networkfirewall_firewall_policy.main.arn
  vpc_id              = aws_vpc.inspection.id

  dynamic "subnet_mapping" {
    for_each = aws_subnet.inspection_firewall
    content {
      subnet_id = subnet_mapping.value.id
    }
  }

  tags = {
    Name        = "nfw-${var.environment}"
    Environment = var.environment
  }
}

resource "aws_networkfirewall_firewall_policy" "main" {
  name = "nfw-policy-${var.environment}"

  firewall_policy {
    stateless_default_actions          = ["aws:forward_to_sfe"]
    stateless_fragment_default_actions = ["aws:forward_to_sfe"]

    stateful_rule_group_reference {
      resource_arn = aws_networkfirewall_rule_group.block_malicious.arn
    }

    stateful_rule_group_reference {
      resource_arn = aws_networkfirewall_rule_group.allow_internal.arn
    }
  }

  tags = {
    Name        = "nfw-policy-${var.environment}"
    Environment = var.environment
  }
}

resource "aws_networkfirewall_rule_group" "block_malicious" {
  capacity = 100
  name     = "block-malicious-${var.environment}"
  type     = "STATEFUL"

  rule_group {
    rules_source {
      rules_source_list {
        generated_rules_type = "DENYLIST"
        target_types         = ["HTTP_HOST", "TLS_SNI"]
        targets              = [
          ".malware-domain.com",
          ".phishing-site.net"
        ]
      }
    }
  }

  tags = {
    Name        = "nfw-rg-block-malicious"
    Environment = var.environment
  }
}

resource "aws_networkfirewall_rule_group" "allow_internal" {
  capacity = 100
  name     = "allow-internal-${var.environment}"
  type     = "STATEFUL"

  rule_group {
    rules_source {
      stateful_rule {
        action = "PASS"
        header {
          destination      = "10.0.0.0/8"
          destination_port = "ANY"
          direction        = "ANY"
          protocol         = "IP"
          source           = "10.0.0.0/8"
          source_port      = "ANY"
        }
        rule_option {
          keyword = "sid:1"
        }
      }
    }
  }

  tags = {
    Name        = "nfw-rg-allow-internal"
    Environment = var.environment
  }
}
```

## Monitoring and Observability

### CloudWatch Dashboards

```hcl
# monitoring.tf
resource "aws_cloudwatch_dashboard" "transit_gateway" {
  dashboard_name = "transit-gateway-${var.environment}"

  dashboard_body = jsonencode({
    widgets = [
      {
        type = "metric"
        properties = {
          metrics = [
            ["AWS/TransitGateway", "BytesIn", { stat = "Sum", label = "Bytes In" }],
            [".", "BytesOut", { stat = "Sum", label = "Bytes Out" }]
          ]
          period = 300
          stat   = "Sum"
          region = var.aws_region
          title  = "Transit Gateway Traffic"
          yAxis = {
            left = {
              label = "Bytes"
            }
          }
        }
      },
      {
        type = "metric"
        properties = {
          metrics = [
            ["AWS/TransitGateway", "PacketDropCountBlackhole", { stat = "Sum" }],
            [".", "PacketDropCountNoRoute", { stat = "Sum" }]
          ]
          period = 300
          stat   = "Sum"
          region = var.aws_region
          title  = "Dropped Packets"
        }
      },
      {
        type = "metric"
        properties = {
          metrics = [
            ["AWS/VPN", "TunnelState", {
              dimensions = {
                VpnId = aws_vpn_connection.main.id
              }
              stat = "Minimum"
            }]
          ]
          period = 60
          stat   = "Minimum"
          region = var.aws_region
          title  = "VPN Tunnel Status"
        }
      }
    ]
  })
}

# SNS topic for alerts
resource "aws_sns_topic" "network_alerts" {
  name = "network-alerts-${var.environment}"

  tags = {
    Environment = var.environment
    Purpose     = "Network-Monitoring"
  }
}

resource "aws_sns_topic_subscription" "network_alerts_email" {
  topic_arn = aws_sns_topic.network_alerts.arn
  protocol  = "email"
  endpoint  = "network-ops@example.com"
}

# VPN tunnel alarms
resource "aws_cloudwatch_metric_alarm" "vpn_tunnel1_down" {
  alarm_name          = "vpn-tunnel1-down-${var.environment}"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "TunnelState"
  namespace           = "AWS/VPN"
  period              = 60
  statistic           = "Minimum"
  threshold           = 1
  alarm_description   = "VPN Tunnel 1 is down"
  treat_missing_data  = "breaching"

  dimensions = {
    VpnId = aws_vpn_connection.main.id
  }

  alarm_actions = [aws_sns_topic.network_alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "vpn_tunnel2_down" {
  alarm_name          = "vpn-tunnel2-down-${var.environment}"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "TunnelState"
  namespace           = "AWS/VPN"
  period              = 60
  statistic           = "Minimum"
  threshold           = 1
  alarm_description   = "VPN Tunnel 2 is down"
  treat_missing_data  = "breaching"

  dimensions = {
    VpnId = aws_vpn_connection.main.id
  }

  alarm_actions = [aws_sns_topic.network_alerts.arn]
}

# Transit Gateway attachment alarms
resource "aws_cloudwatch_metric_alarm" "tgw_packet_drop" {
  alarm_name          = "tgw-packet-drop-high-${var.environment}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "PacketDropCountNoRoute"
  namespace           = "AWS/TransitGateway"
  period              = 300
  statistic           = "Sum"
  threshold           = 1000
  alarm_description   = "High packet drop rate on Transit Gateway"

  dimensions = {
    TransitGateway = aws_ec2_transit_gateway.main.id
  }

  alarm_actions = [aws_sns_topic.network_alerts.arn]
}
```

### VPC Flow Logs Analysis

```hcl
# flow-logs.tf
resource "aws_flow_log" "transit_gateway" {
  log_destination      = aws_cloudwatch_log_group.flow_logs.arn
  log_destination_type = "cloud-watch-logs"
  traffic_type         = "ALL"
  iam_role_arn         = aws_iam_role.flow_logs.arn

  transit_gateway_id = aws_ec2_transit_gateway.main.id

  tags = {
    Name        = "flow-logs-tgw-${var.environment}"
    Environment = var.environment
  }
}

resource "aws_cloudwatch_log_group" "flow_logs" {
  name              = "/aws/transitgateway/${var.environment}/flowlogs"
  retention_in_days = 30

  tags = {
    Environment = var.environment
  }
}

resource "aws_iam_role" "flow_logs" {
  name = "transit-gateway-flow-logs-${var.environment}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "vpc-flow-logs.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy" "flow_logs" {
  name = "transit-gateway-flow-logs-policy"
  role = aws_iam_role.flow_logs.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogGroups",
          "logs:DescribeLogStreams"
        ]
        Effect = "Allow"
        Resource = "*"
      }
    ]
  })
}

# CloudWatch Insights queries for flow logs
resource "aws_cloudwatch_query_definition" "top_talkers" {
  name = "TransitGateway-TopTalkers-${var.environment}"

  log_group_names = [
    aws_cloudwatch_log_group.flow_logs.name
  ]

  query_string = <<-QUERY
    fields @timestamp, srcAddr, dstAddr, bytes
    | filter action = "ACCEPT"
    | stats sum(bytes) as totalBytes by srcAddr, dstAddr
    | sort totalBytes desc
    | limit 20
  QUERY
}

resource "aws_cloudwatch_query_definition" "rejected_connections" {
  name = "TransitGateway-RejectedConnections-${var.environment}"

  log_group_names = [
    aws_cloudwatch_log_group.flow_logs.name
  ]

  query_string = <<-QUERY
    fields @timestamp, srcAddr, dstAddr, srcPort, dstPort, protocol
    | filter action = "REJECT"
    | stats count() as rejectedCount by srcAddr, dstAddr, dstPort
    | sort rejectedCount desc
    | limit 50
  QUERY
}
```

## Multi-Region Transit Gateway Peering

### Cross-Region Peering Configuration

```hcl
# multi-region.tf
variable "peer_region" {
  description = "Peer region for Transit Gateway peering"
  type        = string
  default     = "us-west-2"
}

# Create Transit Gateway in peer region
provider "aws" {
  alias  = "peer"
  region = var.peer_region
}

resource "aws_ec2_transit_gateway" "peer" {
  provider = aws.peer

  description                     = "Transit Gateway for ${var.environment} in ${var.peer_region}"
  amazon_side_asn                 = 64514
  default_route_table_association = "disable"
  default_route_table_propagation = "disable"
  dns_support                     = "enable"
  vpn_ecmp_support               = "enable"

  tags = {
    Name        = "tgw-${var.environment}-${var.peer_region}"
    Environment = var.environment
    Region      = var.peer_region
  }
}

# Create peering attachment
resource "aws_ec2_transit_gateway_peering_attachment" "main_to_peer" {
  peer_region             = var.peer_region
  peer_transit_gateway_id = aws_ec2_transit_gateway.peer.id
  transit_gateway_id      = aws_ec2_transit_gateway.main.id

  tags = {
    Name        = "tgw-peer-${var.aws_region}-to-${var.peer_region}"
    Environment = var.environment
  }
}

# Accept peering attachment in peer region
resource "aws_ec2_transit_gateway_peering_attachment_accepter" "peer" {
  provider = aws.peer

  transit_gateway_attachment_id = aws_ec2_transit_gateway_peering_attachment.main_to_peer.id

  tags = {
    Name        = "tgw-peer-${var.peer_region}-from-${var.aws_region}"
    Environment = var.environment
  }
}

# Add routes for cross-region traffic
resource "aws_ec2_transit_gateway_route" "main_to_peer_cidrs" {
  for_each = toset(["10.1.0.0/16", "10.2.0.0/16"]) # Peer region VPC CIDRs

  destination_cidr_block         = each.value
  transit_gateway_attachment_id  = aws_ec2_transit_gateway_peering_attachment.main_to_peer.id
  transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table.production.id
}

resource "aws_ec2_transit_gateway_route" "peer_to_main_cidrs" {
  provider = aws.peer

  for_each = toset(["10.10.0.0/16", "10.20.0.0/16"]) # Main region VPC CIDRs

  destination_cidr_block         = each.value
  transit_gateway_attachment_id  = aws_ec2_transit_gateway_peering_attachment.main_to_peer.id
  transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table.production.id
}
```

## Troubleshooting and Operations

### Diagnostic Scripts

```python
#!/usr/bin/env python3
"""
transit_gateway_diagnostics.py - Comprehensive Transit Gateway diagnostics
"""

import boto3
import json
from datetime import datetime, timedelta
from typing import Dict, List, Any

class TransitGatewayDiagnostics:
    def __init__(self, region: str):
        self.ec2 = boto3.client('ec2', region_name=region)
        self.cloudwatch = boto3.client('cloudwatch', region_name=region)
        self.region = region

    def get_transit_gateway_details(self, tgw_id: str) -> Dict[str, Any]:
        """Get Transit Gateway configuration details"""
        response = self.ec2.describe_transit_gateways(
            TransitGatewayIds=[tgw_id]
        )
        return response['TransitGateways'][0]

    def get_attachments(self, tgw_id: str) -> List[Dict[str, Any]]:
        """Get all Transit Gateway attachments"""
        attachments = []
        paginator = self.ec2.get_paginator('describe_transit_gateway_attachments')

        for page in paginator.paginate(
            Filters=[{'Name': 'transit-gateway-id', 'Values': [tgw_id]}]
        ):
            attachments.extend(page['TransitGatewayAttachments'])

        return attachments

    def get_route_tables(self, tgw_id: str) -> List[Dict[str, Any]]:
        """Get all Transit Gateway route tables"""
        route_tables = []
        paginator = self.ec2.get_paginator('describe_transit_gateway_route_tables')

        for page in paginator.paginate(
            Filters=[{'Name': 'transit-gateway-id', 'Values': [tgw_id]}]
        ):
            route_tables.extend(page['TransitGatewayRouteTables'])

        return route_tables

    def get_routes(self, route_table_id: str) -> List[Dict[str, Any]]:
        """Get routes from a Transit Gateway route table"""
        response = self.ec2.search_transit_gateway_routes(
            TransitGatewayRouteTableId=route_table_id,
            Filters=[{'Name': 'state', 'Values': ['active', 'blackhole']}]
        )
        return response['Routes']

    def check_vpn_health(self, tgw_id: str) -> List[Dict[str, Any]]:
        """Check VPN connection health"""
        vpn_status = []

        # Get VPN attachments
        attachments = [a for a in self.get_attachments(tgw_id)
                      if a['ResourceType'] == 'vpn']

        for attachment in attachments:
            vpn_id = attachment['ResourceId']

            # Get VPN connection details
            vpn_response = self.ec2.describe_vpn_connections(
                VpnConnectionIds=[vpn_id]
            )

            if vpn_response['VpnConnections']:
                vpn = vpn_response['VpnConnections'][0]

                status = {
                    'vpn_id': vpn_id,
                    'state': vpn['State'],
                    'tunnels': []
                }

                for i, tunnel in enumerate(vpn['VgwTelemetry'], 1):
                    tunnel_info = {
                        'tunnel_number': i,
                        'status': tunnel['Status'],
                        'outside_ip': tunnel.get('OutsideIpAddress'),
                        'last_status_change': tunnel.get('LastStatusChange'),
                        'status_message': tunnel.get('StatusMessage')
                    }
                    status['tunnels'].append(tunnel_info)

                    # Get CloudWatch metrics for tunnel
                    metrics = self.get_vpn_tunnel_metrics(vpn_id, i)
                    tunnel_info['metrics'] = metrics

                vpn_status.append(status)

        return vpn_status

    def get_vpn_tunnel_metrics(self, vpn_id: str, tunnel: int) -> Dict[str, Any]:
        """Get CloudWatch metrics for VPN tunnel"""
        end_time = datetime.utcnow()
        start_time = end_time - timedelta(hours=1)

        metrics = {}

        # Tunnel data in/out
        for metric_name in ['TunnelDataIn', 'TunnelDataOut']:
            response = self.cloudwatch.get_metric_statistics(
                Namespace='AWS/VPN',
                MetricName=metric_name,
                Dimensions=[
                    {'Name': 'VpnId', 'Value': vpn_id},
                    {'Name': 'TunnelIpAddress', 'Value': str(tunnel)}
                ],
                StartTime=start_time,
                EndTime=end_time,
                Period=300,
                Statistics=['Sum', 'Average']
            )

            if response['Datapoints']:
                metrics[metric_name.lower()] = {
                    'average': sum(d['Average'] for d in response['Datapoints']) / len(response['Datapoints']),
                    'total': sum(d['Sum'] for d in response['Datapoints'])
                }

        return metrics

    def check_attachment_bandwidth(self, tgw_id: str) -> List[Dict[str, Any]]:
        """Check bandwidth utilization for attachments"""
        attachments = self.get_attachments(tgw_id)
        bandwidth_stats = []

        end_time = datetime.utcnow()
        start_time = end_time - timedelta(hours=1)

        for attachment in attachments:
            attachment_id = attachment['TransitGatewayAttachmentId']

            stats = {
                'attachment_id': attachment_id,
                'resource_type': attachment['ResourceType'],
                'resource_id': attachment['ResourceId'],
                'state': attachment['State']
            }

            # Get bytes in/out metrics
            for metric_name in ['BytesIn', 'BytesOut']:
                response = self.cloudwatch.get_metric_statistics(
                    Namespace='AWS/TransitGateway',
                    MetricName=metric_name,
                    Dimensions=[
                        {'Name': 'TransitGateway', 'Value': tgw_id},
                        {'Name': 'TransitGatewayAttachment', 'Value': attachment_id}
                    ],
                    StartTime=start_time,
                    EndTime=end_time,
                    Period=300,
                    Statistics=['Average', 'Maximum', 'Sum']
                )

                if response['Datapoints']:
                    datapoints = response['Datapoints']
                    stats[metric_name.lower()] = {
                        'average_bps': sum(d['Average'] for d in datapoints) / len(datapoints) * 8,
                        'max_bps': max(d['Maximum'] for d in datapoints) * 8,
                        'total_bytes': sum(d['Sum'] for d in datapoints)
                    }

            bandwidth_stats.append(stats)

        return bandwidth_stats

    def verify_routing(self, tgw_id: str) -> Dict[str, Any]:
        """Verify routing configuration"""
        route_tables = self.get_route_tables(tgw_id)
        routing_info = {
            'route_tables': [],
            'issues': []
        }

        for rt in route_tables:
            rt_id = rt['TransitGatewayRouteTableId']
            rt_info = {
                'route_table_id': rt_id,
                'state': rt['State'],
                'routes': [],
                'associations': [],
                'propagations': []
            }

            # Get routes
            routes = self.get_routes(rt_id)
            for route in routes:
                route_info = {
                    'destination': route['DestinationCidrBlock'],
                    'type': route['Type'],
                    'state': route['State']
                }

                if 'TransitGatewayAttachments' in route:
                    route_info['attachment'] = route['TransitGatewayAttachments'][0].get('TransitGatewayAttachmentId')

                rt_info['routes'].append(route_info)

                # Check for blackhole routes
                if route['State'] == 'blackhole':
                    routing_info['issues'].append({
                        'type': 'blackhole_route',
                        'route_table': rt_id,
                        'destination': route['DestinationCidrBlock']
                    })

            # Get associations
            assoc_response = self.ec2.get_transit_gateway_route_table_associations(
                TransitGatewayRouteTableId=rt_id
            )
            rt_info['associations'] = [
                {
                    'attachment_id': a['TransitGatewayAttachmentId'],
                    'resource_type': a['ResourceType'],
                    'resource_id': a['ResourceId'],
                    'state': a['State']
                }
                for a in assoc_response['Associations']
            ]

            # Get propagations
            prop_response = self.ec2.get_transit_gateway_route_table_propagations(
                TransitGatewayRouteTableId=rt_id
            )
            rt_info['propagations'] = [
                {
                    'attachment_id': p['TransitGatewayAttachmentId'],
                    'resource_type': p['ResourceType'],
                    'resource_id': p['ResourceId'],
                    'state': p['State']
                }
                for p in prop_response['TransitGatewayRouteTablePropagations']
            ]

            routing_info['route_tables'].append(rt_info)

        return routing_info

    def generate_report(self, tgw_id: str) -> str:
        """Generate comprehensive diagnostic report"""
        print(f"Generating diagnostic report for Transit Gateway: {tgw_id}")

        report = {
            'timestamp': datetime.utcnow().isoformat(),
            'region': self.region,
            'transit_gateway_id': tgw_id,
            'details': self.get_transit_gateway_details(tgw_id),
            'attachments': self.get_attachments(tgw_id),
            'vpn_health': self.check_vpn_health(tgw_id),
            'bandwidth_utilization': self.check_attachment_bandwidth(tgw_id),
            'routing': self.verify_routing(tgw_id)
        }

        return json.dumps(report, indent=2, default=str)

def main():
    import argparse

    parser = argparse.ArgumentParser(
        description='Transit Gateway Diagnostics Tool'
    )
    parser.add_argument(
        '--tgw-id',
        required=True,
        help='Transit Gateway ID'
    )
    parser.add_argument(
        '--region',
        default='us-east-1',
        help='AWS region (default: us-east-1)'
    )
    parser.add_argument(
        '--output',
        help='Output file for report (default: stdout)'
    )

    args = parser.parse_args()

    diagnostics = TransitGatewayDiagnostics(args.region)
    report = diagnostics.generate_report(args.tgw_id)

    if args.output:
        with open(args.output, 'w') as f:
            f.write(report)
        print(f"Report saved to {args.output}")
    else:
        print(report)

if __name__ == '__main__':
    main()
```

## Best Practices and Recommendations

### Security Considerations

1. **Network Segmentation:**
   - Use separate route tables for different security zones
   - Implement strict routing policies between environments
   - Block unnecessary cross-environment traffic

2. **Encryption:**
   - Always use IPSec for VPN connections
   - Enable MACsec for Direct Connect when available
   - Use TLS 1.2+ for all management connections

3. **Access Control:**
   - Implement strict IAM policies for Transit Gateway management
   - Use AWS Organizations SCPs for additional guardrails
   - Enable CloudTrail logging for all API calls

4. **Traffic Inspection:**
   - Deploy AWS Network Firewall for deep packet inspection
   - Use VPC Flow Logs for traffic analysis
   - Implement automated threat detection

### High Availability Design

1. **Redundancy:**
   - Deploy multiple VPN tunnels with ECMP
   - Use Direct Connect with VPN backup
   - Implement multi-AZ attachments

2. **Monitoring:**
   - Configure CloudWatch alarms for all critical metrics
   - Set up automated runbooks for common issues
   - Implement synthetic monitoring for connectivity tests

3. **Disaster Recovery:**
   - Document failover procedures
   - Test DR scenarios regularly
   - Maintain configuration backups

### Cost Optimization

1. **Attachment Management:**
   - Consolidate VPC attachments where possible
   - Remove unused attachments promptly
   - Monitor data transfer costs

2. **Bandwidth Optimization:**
   - Use VPC peering for high-bandwidth same-region traffic
   - Optimize application traffic patterns
   - Implement caching strategies

3. **Resource Tagging:**
   - Tag all resources for cost allocation
   - Use AWS Cost Explorer for analysis
   - Implement automated cost reporting

## Conclusion

AWS Transit Gateway provides a robust, scalable solution for hybrid cloud connectivity. By following the patterns and best practices outlined in this guide, you can build an enterprise-grade network architecture that supports complex multi-VPC, multi-region, and hybrid scenarios while maintaining security, performance, and operational efficiency.

Key takeaways:
- Transit Gateway simplifies network architecture through centralized routing
- Proper route table segmentation enables security isolation
- VPN and Direct Connect integration provides reliable hybrid connectivity
- Comprehensive monitoring ensures operational visibility
- Following best practices reduces costs and improves reliability

The examples provided demonstrate production-ready configurations that can be adapted to your specific requirements, ensuring a secure and scalable hybrid cloud infrastructure.