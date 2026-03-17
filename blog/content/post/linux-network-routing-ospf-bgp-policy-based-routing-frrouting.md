---
title: "Linux Network Routing: OSPF, BGP, and Policy-Based Routing with FRRouting"
date: 2030-08-04T00:00:00-05:00
draft: false
tags: ["Linux", "Networking", "FRRouting", "OSPF", "BGP", "MetalLB", "Routing"]
categories:
- Linux
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise Linux routing with FRRouting (FRR): installation, OSPF areas and LSA types, BGP peering configuration, route redistribution, policy-based routing with ip rules, and Kubernetes BGP load balancing with MetalLB."
more_link: "yes"
url: "/linux-network-routing-ospf-bgp-policy-based-routing-frrouting/"
---

FRRouting (FRR) is the production-grade open-source routing stack that replaced Quagga and is now embedded in network operating systems from Cumulus to DANOS to OpenWrt. When deployed on Linux hosts, FRR transforms bare metal servers and Kubernetes nodes into full-featured routers capable of participating in enterprise BGP and OSPF topologies.

<!--more-->

## Overview

This guide covers FRR installation and configuration for enterprise environments: OSPF area design, BGP peering for WAN connectivity, route redistribution between protocols, Linux kernel policy-based routing (PBR) with `ip rule` and `ip route`, and integrating MetalLB with BGP for Kubernetes service advertisement.

## Installing FRRouting

### Package Installation

```bash
# Ubuntu 22.04 / 24.04
curl -s https://deb.frrouting.org/frr/keys.gpg | sudo tee /usr/share/keyrings/frrouting.gpg > /dev/null
echo "deb [signed-by=/usr/share/keyrings/frrouting.gpg] https://deb.frrouting.org/frr $(lsb_release -s -c) frr-stable" | \
  sudo tee /etc/apt/sources.list.d/frr.list

sudo apt update && sudo apt install -y frr frr-pythontools

# RHEL 9 / Rocky 9
sudo dnf install -y https://rpm.frrouting.org/repo/frr-stable-repo-1-0.el9.noarch.rpm
sudo dnf install -y frr frr-pythontools
```

### Enabling Required Daemons

FRR uses per-protocol daemons. Enable only what is needed:

```bash
# /etc/frr/daemons
zebra=yes       # Required: kernel interface and route manager
bgpd=yes        # Enable for BGP
ospfd=yes       # Enable for OSPFv2
ospf6d=no       # OSPFv3 (IPv6)
ripd=no
ripngd=no
isisd=no
pimd=no
ldpd=no
nhrpd=no
eigrpd=no
babeld=no
sharpd=no
staticd=yes     # Static routes
pbrd=yes        # Policy-based routing daemon
bfdd=yes        # BFD for fast failure detection
vrrpd=no
```

```bash
sudo systemctl enable --now frr
sudo systemctl status frr
```

### Kernel Parameters for Routing

```bash
# /etc/sysctl.d/99-routing.conf

# Enable IP forwarding
net.ipv4.ip_forward = 1
net.ipv6.conf.all.forwarding = 1

# Disable reverse path filtering (required for asymmetric routing)
net.ipv4.conf.all.rp_filter = 0
net.ipv4.conf.default.rp_filter = 0

# Increase routing table size for large networks
net.ipv4.route.max_size = 8388608

# ARP behavior for multi-homed hosts
net.ipv4.conf.all.arp_ignore = 1
net.ipv4.conf.all.arp_announce = 2

# Increase socket buffers for routing daemons
net.core.rmem_max = 67108864
net.core.wmem_max = 67108864

sysctl -p /etc/sysctl.d/99-routing.conf
```

## FRR Configuration Basics

FRR is configured via the `vtysh` interactive shell or by writing configuration files directly.

```bash
# Enter the VTY shell
sudo vtysh

# Show running config
show running-config

# Write to /etc/frr/frr.conf
write memory
```

All configuration below uses the `frr.conf` format which is ingested directly.

## OSPF Configuration

### OSPFv2 Area Design

OSPF areas reduce link-state database (LSDB) size by summarizing topology information. Area 0 (the backbone) is required; all other areas connect to it.

```
# /etc/frr/frr.conf (router running OSPF)

frr version 9.1
frr defaults traditional
hostname spine-01
log syslog informational
service integrated-vtysh-config

interface lo
 ip address 10.255.0.1/32
 ip ospf area 0

interface eth0
 description "Uplink to Core"
 ip address 10.10.0.1/30
 ip ospf area 0
 ip ospf hello-interval 10
 ip ospf dead-interval 40
 ip ospf cost 100
 ip ospf authentication message-digest
 ip ospf message-digest-key 1 md5 <ospf-auth-key>

interface eth1
  description "Downlink to Leaf-01 Area 1"
  ip address 10.10.1.1/30
  ip ospf area 1
  ip ospf hello-interval 10
  ip ospf dead-interval 40

router ospf
 ospf router-id 10.255.0.1

 ! Area 0 - backbone
 network 10.10.0.0/30 area 0
 network 10.255.0.1/32 area 0

 ! Area 1 - access/leaf tier
 network 10.10.1.0/30 area 1
 area 1 range 10.1.0.0/16 cost 100

 ! Area summarization at ABR
 area 1 range 10.1.0.0/16

 ! Stub area: no external LSAs flooded into area 2
 area 2 stub no-summary

 ! NSSA: redistributed external routes use Type 7 LSAs
 area 3 nssa

 ! Passive interfaces (connected, not OSPF-speaking)
 passive-interface eth2
 passive-interface eth3

 ! Route redistribution into OSPF
 redistribute connected route-map CONNECTED_TO_OSPF
 redistribute bgp route-map BGP_TO_OSPF metric 200 metric-type 2

 ! Tuning
 auto-cost reference-bandwidth 100000
 timers spf delay 200 min-holdtime 400 max-holdtime 5000

! Route map controlling which connected routes are redistributed
route-map CONNECTED_TO_OSPF permit 10
 match interface eth2
 set metric 50

route-map CONNECTED_TO_OSPF permit 20
 match interface eth3
 set metric 50
```

### OSPF LSA Types Reference

| LSA Type | Name | Scope | Description |
|----------|------|-------|-------------|
| 1 | Router LSA | Area | Each router's links within the area |
| 2 | Network LSA | Area | Multi-access network segments |
| 3 | Summary LSA | Area | Inter-area routes (from ABR) |
| 4 | ASBR Summary LSA | Area | Location of ASBR |
| 5 | External LSA | AS | External routes (from ASBR) |
| 7 | NSSA External LSA | NSSA Area | External routes within NSSA |

### Verifying OSPF State

```bash
sudo vtysh -c "show ip ospf neighbor"
sudo vtysh -c "show ip ospf database"
sudo vtysh -c "show ip ospf route"
sudo vtysh -c "show ip ospf interface"
sudo vtysh -c "show ip ospf border-routers"
sudo vtysh -c "debug ospf events"
```

Expected neighbor output:

```
Neighbor ID     Pri State           Dead Time Address         Interface
10.255.0.2       1 Full/DR          00:00:36  10.10.0.2       eth0:10.10.0.1
10.255.0.3       1 Full/BDR         00:00:38  10.10.1.2       eth1:10.10.1.1
```

## BGP Configuration

### eBGP Peering Configuration

```
# /etc/frr/frr.conf (edge router performing eBGP with upstream ISPs)

router bgp 65100
 bgp router-id 10.255.0.10
 bgp log-neighbor-changes
 bgp bestpath as-path multipath-relax

 ! Upstream ISP 1 - eBGP
 neighbor 203.0.113.1 remote-as 64500
 neighbor 203.0.113.1 description "ISP-1 Primary"
 neighbor 203.0.113.1 ebgp-multihop 2
 neighbor 203.0.113.1 update-source eth0
 neighbor 203.0.113.1 password <bgp-session-password>
 neighbor 203.0.113.1 timers 30 90
 neighbor 203.0.113.1 timers connect 10

 ! Upstream ISP 2 - eBGP for redundancy
 neighbor 198.51.100.1 remote-as 64501
 neighbor 198.51.100.1 description "ISP-2 Secondary"
 neighbor 198.51.100.1 update-source eth1

 ! iBGP peer - route reflector client
 neighbor 10.255.0.1 remote-as 65100
 neighbor 10.255.0.1 description "Route Reflector 1"
 neighbor 10.255.0.1 update-source lo
 neighbor 10.255.0.1 next-hop-self

 ! Peer groups for scalable configuration
 neighbor INTERNAL peer-group
 neighbor INTERNAL remote-as 65100
 neighbor INTERNAL update-source lo
 neighbor INTERNAL next-hop-self
 neighbor INTERNAL soft-reconfiguration inbound

 neighbor 10.255.0.2 peer-group INTERNAL
 neighbor 10.255.0.3 peer-group INTERNAL
 neighbor 10.255.0.4 peer-group INTERNAL

 address-family ipv4 unicast
  ! Advertise our prefixes
  network 203.0.113.0/24
  network 192.0.2.0/24

  ! Apply inbound and outbound policies to ISP peers
  neighbor 203.0.113.1 route-map ISP1_IN in
  neighbor 203.0.113.1 route-map ISP1_OUT out
  neighbor 203.0.113.1 prefix-list ISP1_ALLOWED_IN in
  neighbor 203.0.113.1 maximum-prefix 800000 90

  neighbor 198.51.100.1 route-map ISP2_IN in
  neighbor 198.51.100.1 route-map ISP2_OUT out
  neighbor 198.51.100.1 maximum-prefix 800000 90

  ! Distribute to INTERNAL peer group
  neighbor INTERNAL route-map INTERNAL_IN in
  neighbor INTERNAL route-map INTERNAL_OUT out

  ! Aggregate for advertisement
  aggregate-address 203.0.113.0/24 summary-only
 exit-address-family
```

### BGP Route Maps and Community Tagging

```
! Prefix lists
ip prefix-list BOGONS seq 5 deny 0.0.0.0/8 le 32
ip prefix-list BOGONS seq 10 deny 10.0.0.0/8 le 32
ip prefix-list BOGONS seq 15 deny 100.64.0.0/10 le 32
ip prefix-list BOGONS seq 20 deny 127.0.0.0/8 le 32
ip prefix-list BOGONS seq 25 deny 169.254.0.0/16 le 32
ip prefix-list BOGONS seq 30 deny 172.16.0.0/12 le 32
ip prefix-list BOGONS seq 35 deny 192.0.0.0/24 le 32
ip prefix-list BOGONS seq 40 deny 192.168.0.0/16 le 32
ip prefix-list BOGONS seq 45 deny 198.18.0.0/15 le 32
ip prefix-list BOGONS seq 50 deny 224.0.0.0/4 le 32
ip prefix-list BOGONS seq 55 deny 240.0.0.0/4 le 32
ip prefix-list BOGONS seq 60 permit 0.0.0.0/0 le 32

! ISP allowed prefixes (only accept routes in their announced ranges)
ip prefix-list ISP1_ALLOWED_IN seq 5 permit 0.0.0.0/0

! Community lists for traffic engineering
bgp community-list standard ISP1_ROUTES permit 65100:100
bgp community-list standard ISP2_ROUTES permit 65100:200

! Inbound from ISP1: tag with community, apply local-pref
route-map ISP1_IN deny 5
 match ip prefix-list BOGONS

route-map ISP1_IN permit 10
 set local-preference 200
 set community 65100:100 additive

! Inbound from ISP2: lower local preference (backup path)
route-map ISP2_IN deny 5
 match ip prefix-list BOGONS

route-map ISP2_IN permit 10
 set local-preference 100
 set community 65100:200 additive

! Outbound to ISP1: strip internal communities, set MED
route-map ISP1_OUT permit 10
 set metric 100
 set community 65100:100 delete

! Redistribute OSPF internal routes into BGP with filtering
route-map OSPF_TO_BGP permit 10
 match ip address prefix-list INTERNAL_NETS
 set local-preference 150
```

### Route Reflector Configuration

In large iBGP deployments, route reflectors eliminate the need for full iBGP mesh:

```
router bgp 65100
 bgp router-id 10.255.0.254
 bgp cluster-id 10.255.0.254

 neighbor RR_CLIENTS peer-group
 neighbor RR_CLIENTS remote-as 65100
 neighbor RR_CLIENTS update-source lo
 neighbor RR_CLIENTS route-reflector-client
 neighbor RR_CLIENTS next-hop-unchanged

 ! Clients
 neighbor 10.255.0.1 peer-group RR_CLIENTS
 neighbor 10.255.0.2 peer-group RR_CLIENTS
 neighbor 10.255.0.3 peer-group RR_CLIENTS

 ! Peer with other route reflectors (non-client iBGP)
 neighbor 10.255.0.253 remote-as 65100
 neighbor 10.255.0.253 description "RR-2 Redundant"
 neighbor 10.255.0.253 update-source lo
```

## Policy-Based Routing with ip rules

The Linux kernel supports multiple routing tables and selects which table to use based on `ip rule` selectors. This enables per-source, per-mark, per-interface routing decisions that bypass the main routing table.

### Routing Table Configuration

```bash
# Define named routing tables in /etc/iproute2/rt_tables
echo "100  isp1" >> /etc/iproute2/rt_tables
echo "200  isp2" >> /etc/iproute2/rt_tables
echo "300  management" >> /etc/iproute2/rt_tables

# Verify
cat /etc/iproute2/rt_tables
```

### Multi-Homed Server PBR Setup

A server with two ISP uplinks needs to route return traffic through the same interface that received the incoming traffic (symmetric routing):

```bash
# ISP1: eth0 = 203.0.113.100/24, gateway 203.0.113.1
# ISP2: eth1 = 198.51.100.100/24, gateway 198.51.100.1
# Management: eth2 = 10.0.0.100/24, gateway 10.0.0.1

# Populate table 100 (ISP1)
ip route add default via 203.0.113.1 dev eth0 table isp1
ip route add 203.0.113.0/24 dev eth0 src 203.0.113.100 table isp1

# Populate table 200 (ISP2)
ip route add default via 198.51.100.1 dev eth1 table isp2
ip route add 198.51.100.0/24 dev eth1 src 198.51.100.100 table isp2

# Populate table 300 (management)
ip route add default via 10.0.0.1 dev eth2 table management
ip route add 10.0.0.0/24 dev eth2 src 10.0.0.100 table management

# Add rules: source address determines which table to use
ip rule add from 203.0.113.100 table isp1 priority 100
ip rule add from 198.51.100.100 table isp2 priority 200
ip rule add from 10.0.0.100 table management priority 300

# Verify rules
ip rule show
```

Expected rule output:

```
0:      from all lookup local
100:    from 203.0.113.100 lookup isp1
200:    from 198.51.100.100 lookup isp2
300:    from 10.0.0.100 lookup management
32766:  from all lookup main
32767:  from all lookup default
```

### Firewall Mark-Based PBR

Mark-based PBR allows routing decisions based on iptables/nftables marks:

```bash
# Mark packets from web servers (ports 80, 443) with mark 1
iptables -t mangle -A OUTPUT -p tcp --sport 80 -j MARK --set-mark 1
iptables -t mangle -A OUTPUT -p tcp --sport 443 -j MARK --set-mark 1

# Mark packets from database traffic with mark 2
iptables -t mangle -A OUTPUT -p tcp --dport 5432 -j MARK --set-mark 2

# Route marked packets to specific tables
ip rule add fwmark 1 table isp1 priority 50
ip rule add fwmark 2 table management priority 51
```

### FRR PBR Daemon

FRR's PBR daemon provides a more operator-friendly interface to Linux PBR:

```
# /etc/frr/frr.conf (PBR section)

pbr-map WEB_TRAFFIC seq 10
 match src-ip 10.1.0.0/16
 match dst-ip 0.0.0.0/0
 set nexthop-group ISP1_NEXTHOPS

pbr-map MGMT_TRAFFIC seq 10
 match src-ip 10.0.0.0/8
 set nexthop-group MGMT_NEXTHOPS

nexthop-group ISP1_NEXTHOPS
 nexthop 203.0.113.1

nexthop-group MGMT_NEXTHOPS
 nexthop 10.0.0.1

interface eth0
 pbr-policy WEB_TRAFFIC

interface eth2
 pbr-policy MGMT_TRAFFIC
```

### Persisting Routes with systemd-networkd

```ini
# /etc/systemd/network/10-eth0.network
[Match]
Name=eth0

[Network]
Address=203.0.113.100/24
Gateway=203.0.113.1

[RoutingPolicyRule]
From=203.0.113.100
Table=100
Priority=100

[Route]
Table=100
Gateway=203.0.113.1
Destination=0.0.0.0/0
```

## BFD for Fast Failure Detection

BFD (Bidirectional Forwarding Detection) allows sub-second failure detection regardless of the IGP hello timers:

```
# /etc/frr/frr.conf (BFD configuration)

bfd
 peer 10.10.0.2
  detect-multiplier 3
  receive-interval 300
  transmit-interval 300
  label "ospf-spine-01-eth0"

router ospf
 ! Associate BFD with OSPF neighbor
 neighbor 10.10.0.2 bfd

router bgp 65100
 neighbor 203.0.113.1 bfd
 neighbor 198.51.100.1 bfd
```

## MetalLB BGP Integration with Kubernetes

MetalLB in BGP mode advertises Kubernetes LoadBalancer service IPs to upstream routers using standard BGP, eliminating the need for hardware load balancers.

### MetalLB BGP Configuration

```yaml
# metallb-config.yaml
apiVersion: metallb.io/v1beta2
kind: BGPPeer
metadata:
  name: spine-01
  namespace: metallb-system
spec:
  myASN: 65001
  peerASN: 65100
  peerAddress: 10.10.0.1
  peerPort: 179
  holdTime: 90s
  keepaliveTime: 30s
  # BFD profile for fast failover
  bfdProfile: fast-bfd
  # Password for BGP session authentication
  password: <bgp-session-password>
---
apiVersion: metallb.io/v1beta2
kind: BGPPeer
metadata:
  name: spine-02
  namespace: metallb-system
spec:
  myASN: 65001
  peerASN: 65100
  peerAddress: 10.10.0.5
  peerPort: 179
  holdTime: 90s
  keepaliveTime: 30s
  password: <bgp-session-password>
---
apiVersion: metallb.io/v1beta1
kind: BFDProfile
metadata:
  name: fast-bfd
  namespace: metallb-system
spec:
  receiveInterval: 300ms
  transmitInterval: 300ms
  detectMultiplier: 3
  echoMode: false
  passiveMode: false
---
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: production-pool
  namespace: metallb-system
spec:
  addresses:
  - 192.0.2.0/24
  - 203.0.113.128/26
  autoAssign: true
---
apiVersion: metallb.io/v1beta1
kind: BGPAdvertisement
metadata:
  name: production-advertisement
  namespace: metallb-system
spec:
  ipAddressPools:
  - production-pool
  peers:
  - spine-01
  - spine-02
  # Aggregate small prefixes
  aggregationLength: 32
  aggregationLengthV6: 128
  communities:
  - 65100:200
  localPref: 150
```

### FRR Configuration on Spine Switches to Accept MetalLB Peers

```
# Spine router configuration accepting MetalLB node BGP sessions
router bgp 65100
 bgp router-id 10.10.0.1

 ! Peer group for all Kubernetes nodes
 neighbor K8S_NODES peer-group
 neighbor K8S_NODES remote-as 65001
 neighbor K8S_NODES timers 30 90
 neighbor K8S_NODES bfd
 neighbor K8S_NODES soft-reconfiguration inbound

 ! Kubernetes nodes (one entry per node)
 neighbor 10.1.1.10 peer-group K8S_NODES
 neighbor 10.1.1.11 peer-group K8S_NODES
 neighbor 10.1.1.12 peer-group K8S_NODES
 neighbor 10.1.1.13 peer-group K8S_NODES
 neighbor 10.1.1.14 peer-group K8S_NODES

 address-family ipv4 unicast
  neighbor K8S_NODES prefix-list K8S_ALLOWED_IN in
  neighbor K8S_NODES route-map K8S_IN in
  neighbor K8S_NODES maximum-prefix 500 90
  ! Redistribute learned service IPs into OSPF
  redistribute bgp route-map K8S_TO_OSPF
 exit-address-family

! Only accept the advertised service prefix range
ip prefix-list K8S_ALLOWED_IN seq 5 permit 192.0.2.0/24 le 32
ip prefix-list K8S_ALLOWED_IN seq 10 permit 203.0.113.128/26 le 32
ip prefix-list K8S_ALLOWED_IN seq 99 deny 0.0.0.0/0 le 32

route-map K8S_IN permit 10
 match ip prefix-list K8S_ALLOWED_IN
 set local-preference 200

route-map K8S_TO_OSPF permit 10
 match ip prefix-list K8S_ALLOWED_IN
 set metric 100
 set metric-type type-2
```

### Verifying MetalLB BGP Sessions

```bash
# From a Kubernetes node with MetalLB speaker running
kubectl -n metallb-system exec -it deploy/metallb-controller -- \
  metallb diagnostics show peers

# From FRR on the spine
sudo vtysh -c "show bgp summary"
sudo vtysh -c "show bgp neighbors 10.1.1.10"
sudo vtysh -c "show bgp ipv4 unicast 192.0.2.1/32"
```

Expected BGP summary output:

```
BGP router identifier 10.10.0.1, local AS number 65100 vrf-id 0
BGP table version 147

Neighbor        V  AS MsgRcvd MsgSent   TblVer  InQ OutQ  Up/Down State/PfxRcd
10.1.1.10       4 65001    4521    3901        0    0    0 01:12:34           18
10.1.1.11       4 65001    4485    3899        0    0    0 01:12:31           18
10.1.1.12       4 65001    4498    3902        0    0    0 01:11:58           17
```

## ECMP Load Balancing

FRR and Linux kernel support Equal-Cost Multi-Path routing for load balancing across multiple next-hops:

```bash
# Enable ECMP in FRR
sudo vtysh << 'EOF'
configure terminal
  ip multipath
  router bgp 65100
    bgp bestpath as-path multipath-relax
    maximum-paths 8
EOF

# Verify ECMP routes
ip route show 192.0.2.0/24
# Expected:
# 192.0.2.0/24 proto bgp metric 20
#   nexthop via 10.1.1.10 dev eth0 weight 1
#   nexthop via 10.1.1.11 dev eth0 weight 1
#   nexthop via 10.1.1.12 dev eth0 weight 1
```

## Troubleshooting Reference

### OSPF Adjacency Issues

```bash
# Check interface configuration
sudo vtysh -c "show ip ospf interface eth0"

# Confirm hello/dead timer mismatch (must match on both ends)
sudo vtysh -c "show ip ospf neighbor detail"

# Debug OSPF packets
sudo vtysh -c "debug ospf packet all"
# Watch via journal:
sudo journalctl -fu frr | grep ospf
```

Common OSPF adjacency failures:
- Area ID mismatch
- Authentication key or type mismatch
- Hello/dead timer mismatch
- MTU mismatch (use `ip ospf mtu-ignore` if VMs/tunnels have lower MTU)
- Duplicate router IDs

### BGP Session Troubleshooting

```bash
# Check session state
sudo vtysh -c "show bgp neighbors 203.0.113.1"

# View received routes
sudo vtysh -c "show bgp ipv4 unicast neighbors 203.0.113.1 received-routes"

# View advertised routes
sudo vtysh -c "show bgp ipv4 unicast neighbors 203.0.113.1 advertised-routes"

# Check for route-map filtering
sudo vtysh -c "show route-map ISP1_IN"

# Enable session debug
sudo vtysh -c "debug bgp neighbor-events"
sudo vtysh -c "debug bgp updates in"
```

## Summary

FRRouting on Linux provides enterprise-class routing capabilities on commodity hardware. OSPF with proper area design provides scalable intra-domain routing with fast convergence. BGP with community-based traffic engineering enables sophisticated multi-homing policies. Policy-based routing with `ip rule` handles asymmetric routing and multi-homed server configurations. MetalLB in BGP mode integrates Kubernetes services directly into the routing fabric, providing true anycast load balancing without hardware dependencies. Together, these tools form a complete routing stack for production data center and edge environments.
