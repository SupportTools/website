---
title: "Linux WireGuard VPN: Site-to-Site Tunnels and Kubernetes Pod Network Extensions"
date: 2030-10-24T00:00:00-05:00
draft: false
tags: ["WireGuard", "VPN", "Linux", "Kubernetes", "Networking", "Site-to-Site"]
categories:
- Linux
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise WireGuard guide covering kernel module vs userspace implementations, wg-quick configuration, multi-peer mesh topologies, site-to-site VPN for Kubernetes cluster interconnect, NetworkManager integration, and monitoring WireGuard tunnel health in production."
more_link: "yes"
url: "/linux-wireguard-vpn-site-to-site-kubernetes-pod-network-extensions/"
---

WireGuard's combination of a minimal codebase (under 4,000 lines), in-kernel performance, and modern cryptography has made it the default choice for new VPN deployments on Linux. Understanding how to configure multi-peer mesh topologies, extend Kubernetes pod networks across sites, and monitor tunnel health in production separates a prototype WireGuard setup from an enterprise-grade one.

<!--more-->

This guide covers every stage from initial kernel module verification to full Kubernetes cluster interconnect with automated key rotation.

## Section 1: WireGuard Architecture Fundamentals

WireGuard operates at Layer 3. Each peer has a public/private key pair. A peer identifies itself and authenticates using its public key. Routing decisions are made based on the allowed IP ranges configured for each peer—if a packet's source address matches a peer's allowed IPs list on receipt, or a packet's destination matches on send, WireGuard handles it.

### Cryptographic Primitives

- **Key exchange**: Noise protocol framework using Curve25519
- **Encryption**: ChaCha20Poly1305 AEAD
- **Hashing**: BLAKE2s
- **Key size**: 32-byte (256-bit) keys

### Kernel Module vs Userspace

| Mode | Package | Performance | Use Case |
|------|---------|-------------|----------|
| Kernel module | `wireguard-linux` | Best (in-kernel) | Linux 5.6+ native, older kernels via DKMS |
| Kernel DKMS | `wireguard-dkms` | Near-native | Kernels before 5.6 |
| Userspace (wireguard-go) | `wireguard-go` | ~30% slower | macOS, Windows, non-Linux |
| Userspace (boringtun) | `boringtun` | Moderate | Containers without kernel access |

Check whether the kernel module is available:

```bash
# Linux 5.6+ (module built-in)
modinfo wireguard

# Load if not auto-loaded
modprobe wireguard

# Verify
lsmod | grep wireguard
```

Install tools:

```bash
# Debian/Ubuntu
apt-get install wireguard wireguard-tools

# RHEL/Rocky/AlmaLinux 8+
dnf install wireguard-tools elrepo-release
# For older kernels needing DKMS:
dnf install kmod-wireguard

# Arch Linux
pacman -S wireguard-tools
```

## Section 2: Key Generation and Basic Interface Setup

### Generating Key Pairs

```bash
# Generate private key (keep secret)
wg genkey > /etc/wireguard/private.key
chmod 600 /etc/wireguard/private.key

# Derive public key
wg pubkey < /etc/wireguard/private.key > /etc/wireguard/public.key

# Generate pre-shared key for additional symmetric encryption layer
wg genpsk > /etc/wireguard/preshared.key
chmod 600 /etc/wireguard/preshared.key

# Display public key (share this with peers)
cat /etc/wireguard/public.key
```

### Single Peer Configuration (wg0.conf)

```ini
# /etc/wireguard/wg0.conf — Site A (Hub)
[Interface]
# WireGuard tunnel IP (CIDR notation)
Address = 10.200.0.1/24
# UDP port to listen on
ListenPort = 51820
# Private key (read from file for security)
PrivateKey = <base64-encoded-private-key>
# Bring up masquerading for spoke traffic to reach the internet via hub
PostUp = iptables -A FORWARD -i %i -j ACCEPT; iptables -A FORWARD -o %i -j ACCEPT; iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
PostDown = iptables -D FORWARD -i %i -j ACCEPT; iptables -D FORWARD -o %i -j ACCEPT; iptables -t nat -D POSTROUTING -o eth0 -j MASQUERADE

# Save on-the-fly peer changes to disk
SaveConfig = false

[Peer]
# Site B Router
PublicKey = <site-b-public-key>
PresharedKey = <base64-encoded-preshared-key>
# Allowed source IPs from this peer (and routes to push)
AllowedIPs = 10.200.0.2/32, 192.168.2.0/24
# Endpoint for this peer (IP:port)
Endpoint = 203.0.113.50:51820
# Send keepalive to maintain NAT mappings (seconds)
PersistentKeepalive = 25

[Peer]
# Site C Router
PublicKey = <site-c-public-key>
PresharedKey = <base64-encoded-preshared-key>
AllowedIPs = 10.200.0.3/32, 192.168.3.0/24
Endpoint = 203.0.113.75:51820
PersistentKeepalive = 25
```

```ini
# /etc/wireguard/wg0.conf — Site B (Spoke)
[Interface]
Address = 10.200.0.2/24
ListenPort = 51820
PrivateKey = <site-b-private-key>

# Route all traffic through Site A hub
PostUp = ip route add 192.168.2.0/24 dev wg0
PostDown = ip route del 192.168.2.0/24 dev wg0

[Peer]
# Site A Hub
PublicKey = <site-a-public-key>
PresharedKey = <base64-encoded-preshared-key>
AllowedIPs = 10.200.0.0/24, 192.168.1.0/24, 192.168.3.0/24
Endpoint = 203.0.113.25:51820
PersistentKeepalive = 25
```

### Interface Management

```bash
# Bring up interface
wg-quick up wg0

# Bring down interface
wg-quick down wg0

# Enable at boot
systemctl enable wg-quick@wg0
systemctl start wg-quick@wg0

# Show interface status and peer handshakes
wg show wg0

# Show all interfaces
wg show
```

## Section 3: Multi-Peer Mesh Topology

In a full mesh, every site connects directly to every other site. For N sites, each needs N-1 peer entries. This eliminates the hub bottleneck but increases configuration complexity quadratically.

### Three-Site Full Mesh

```ini
# Site A — /etc/wireguard/wg0.conf
[Interface]
Address = 10.200.0.1/24
ListenPort = 51820
PrivateKey = <site-a-private-key>

[Peer]
# Site B
PublicKey = <site-b-public-key>
PresharedKey = <psk-a-b>
AllowedIPs = 10.200.0.2/32, 172.16.2.0/24
Endpoint = 203.0.113.50:51820
PersistentKeepalive = 25

[Peer]
# Site C
PublicKey = <site-c-public-key>
PresharedKey = <psk-a-c>
AllowedIPs = 10.200.0.3/32, 172.16.3.0/24
Endpoint = 203.0.113.75:51820
PersistentKeepalive = 25
```

```ini
# Site B — /etc/wireguard/wg0.conf
[Interface]
Address = 10.200.0.2/24
ListenPort = 51820
PrivateKey = <site-b-private-key>

[Peer]
# Site A
PublicKey = <site-a-public-key>
PresharedKey = <psk-a-b>
AllowedIPs = 10.200.0.1/32, 172.16.1.0/24
Endpoint = 203.0.113.25:51820
PersistentKeepalive = 25

[Peer]
# Site C
PublicKey = <site-c-public-key>
PresharedKey = <psk-b-c>
AllowedIPs = 10.200.0.3/32, 172.16.3.0/24
Endpoint = 203.0.113.75:51820
PersistentKeepalive = 25
```

### Automated Mesh Configuration with Ansible

For large meshes, manual configuration is error-prone. This Ansible role generates all peer configurations from a vars file:

```yaml
# group_vars/wireguard_mesh.yml
wireguard_mesh_cidr: "10.200.0.0/24"
wireguard_listen_port: 51820
wireguard_keepalive: 25

wireguard_peers:
  - name: site-a
    wg_ip: 10.200.0.1
    endpoint: 203.0.113.25
    lan_cidr: 172.16.1.0/24
    public_key: <site-a-public-key>

  - name: site-b
    wg_ip: 10.200.0.2
    endpoint: 203.0.113.50
    lan_cidr: 172.16.2.0/24
    public_key: <site-b-public-key>

  - name: site-c
    wg_ip: 10.200.0.3
    endpoint: 203.0.113.75
    lan_cidr: 172.16.3.0/24
    public_key: <site-c-public-key>
```

```yaml
# roles/wireguard_mesh/tasks/main.yml
- name: Generate WireGuard configuration
  template:
    src: wg0.conf.j2
    dest: /etc/wireguard/wg0.conf
    owner: root
    group: root
    mode: '0600'
  notify: Reload WireGuard

- name: Enable and start WireGuard
  systemd:
    name: wg-quick@wg0
    enabled: true
    state: started
```

```ini
# roles/wireguard_mesh/templates/wg0.conf.j2
[Interface]
Address = {{ hostvars[inventory_hostname]['wg_ip'] }}/24
ListenPort = {{ wireguard_listen_port }}
PrivateKey = {{ wireguard_private_key }}

{% for peer in wireguard_peers %}
{% if peer.name != inventory_hostname %}
[Peer]
# {{ peer.name }}
PublicKey = {{ peer.public_key }}
AllowedIPs = {{ peer.wg_ip }}/32, {{ peer.lan_cidr }}
Endpoint = {{ peer.endpoint }}:{{ wireguard_listen_port }}
PersistentKeepalive = {{ wireguard_keepalive }}

{% endif %}
{% endfor %}
```

## Section 4: Kubernetes Cluster Interconnect via WireGuard

Connecting Kubernetes clusters across data centers requires routing pod CIDR ranges through the WireGuard tunnel. The approach differs by CNI plugin.

### Prerequisites

Each cluster must use non-overlapping CIDRs:

| Cluster | Pod CIDR | Service CIDR | Node CIDR |
|---------|----------|-------------|-----------|
| Cluster A (us-east-1) | 10.10.0.0/16 | 10.96.0.0/12 | 172.16.1.0/24 |
| Cluster B (us-west-2) | 10.20.0.0/16 | 10.112.0.0/12 | 172.16.2.0/24 |

### Gateway Node Configuration

Each cluster has a dedicated gateway node that runs WireGuard and handles cross-cluster routing:

```bash
# On Cluster A gateway node (172.16.1.10)
# Enable IP forwarding
cat > /etc/sysctl.d/99-wireguard-forward.conf << 'EOF'
net.ipv4.ip_forward = 1
net.ipv6.conf.all.forwarding = 1
EOF
sysctl --system
```

```ini
# /etc/wireguard/wg-cluster.conf on Cluster A gateway
[Interface]
Address = 10.200.1.1/30
ListenPort = 51821
PrivateKey = <cluster-a-gateway-private-key>

# Route pod traffic from Cluster B through the tunnel
PostUp = ip route add 10.20.0.0/16 dev wg-cluster
PostUp = ip route add 10.112.0.0/12 dev wg-cluster
PostDown = ip route del 10.20.0.0/16 dev wg-cluster
PostDown = ip route del 10.112.0.0/12 dev wg-cluster

[Peer]
# Cluster B gateway
PublicKey = <cluster-b-gateway-public-key>
PresharedKey = <cross-cluster-psk>
AllowedIPs = 10.200.1.2/32, 10.20.0.0/16, 10.112.0.0/12, 172.16.2.0/24
Endpoint = 203.0.113.50:51821
PersistentKeepalive = 25
```

### Cilium ClusterMesh as an Alternative

For Cilium-based clusters, ClusterMesh provides cross-cluster service discovery and network policy without manual WireGuard routing:

```bash
# Install Cilium with WireGuard encryption enabled
helm upgrade --install cilium cilium/cilium \
  --namespace kube-system \
  --version 1.16.0 \
  --set encryption.enabled=true \
  --set encryption.type=wireguard \
  --set encryption.wireguard.persistentKeepalive=25 \
  --set cluster.name=cluster-a \
  --set cluster.id=1

# Enable ClusterMesh
cilium clustermesh enable --service-type LoadBalancer

# Connect clusters (run from either cluster)
cilium clustermesh connect \
  --destination-context cluster-b-context \
  --source-context cluster-a-context
```

### Manual Cross-Cluster Service Routing

When not using a service mesh, create a ServiceEntry or configure kube-proxy to reach cross-cluster services:

```yaml
# ExternalName service pointing to cross-cluster endpoint
apiVersion: v1
kind: Service
metadata:
  name: payments-service-cluster-b
  namespace: production
spec:
  type: ExternalName
  externalName: payments-service.production.svc.cluster-b.local
  ports:
    - port: 8080
      targetPort: 8080
---
# Or use Endpoints object pointing to the remote pod IPs
apiVersion: v1
kind: Service
metadata:
  name: payments-service-remote
  namespace: production
spec:
  ports:
    - port: 8080
---
apiVersion: v1
kind: Endpoints
metadata:
  name: payments-service-remote
  namespace: production
subsets:
  - addresses:
      - ip: 10.20.5.10  # Pod IP in Cluster B
      - ip: 10.20.5.11
    ports:
      - port: 8080
```

### Flannel with WireGuard Backend

Flannel supports WireGuard as a backend for pod network encryption:

```json
{
  "Network": "10.10.0.0/16",
  "Backend": {
    "Type": "wireguard",
    "PersistentKeepaliveInterval": 25,
    "Mode": "separate"
  }
}
```

Deploy Flannel with the WireGuard backend:

```bash
kubectl apply -f https://raw.githubusercontent.com/flannel-io/flannel/master/Documentation/kube-flannel.yml
# Then patch the ConfigMap to use wireguard backend
kubectl patch configmap kube-flannel-cfg -n kube-flannel \
  --type=json \
  -p='[{"op":"replace","path":"/data/net-conf.json","value":"{\"Network\":\"10.10.0.0/16\",\"Backend\":{\"Type\":\"wireguard\"}}"}]'
```

## Section 5: NetworkManager Integration

On desktop and server systems managed by NetworkManager, use nmcli to manage WireGuard tunnels:

```bash
# Create a WireGuard connection via nmcli
nmcli connection add \
  type wireguard \
  ifname wg0 \
  con-name "office-vpn" \
  ipv4.method manual \
  ipv4.addresses 10.200.0.5/24 \
  ipv4.dns 10.200.0.1 \
  wireguard.private-key "<private-key-value>" \
  wireguard.listen-port 51820

# Add a peer to the connection
nmcli connection modify "office-vpn" \
  +wireguard.peers "public-key=<peer-public-key>,endpoint=vpn.example.com:51820,allowed-ips=0.0.0.0/0,persistent-keepalive=25"

# Bring up the connection
nmcli connection up "office-vpn"

# Check status
nmcli connection show "office-vpn"
```

### Using /etc/NetworkManager/system-connections/

```ini
# /etc/NetworkManager/system-connections/office-vpn.nmconnection
[connection]
id=office-vpn
type=wireguard
interface-name=wg0
autoconnect=true

[wireguard]
listen-port=51820
private-key=<private-key-value>

[wireguard-peer.<peer-public-key>]
endpoint=vpn.example.com:51820
allowed-ips=10.0.0.0/8;
persistent-keepalive=25

[ipv4]
address1=10.200.0.5/24
dns=10.200.0.1;
method=manual

[ipv6]
method=ignore
```

```bash
chmod 600 /etc/NetworkManager/system-connections/office-vpn.nmconnection
nmcli connection reload
nmcli connection up office-vpn
```

## Section 6: Monitoring WireGuard Tunnel Health

### Prometheus WireGuard Exporter

```bash
# Install prometheus-wireguard-exporter
wget https://github.com/MindFlavor/prometheus_wireguard_exporter/releases/latest/download/prometheus_wireguard_exporter-linux-x86_64
mv prometheus_wireguard_exporter-linux-x86_64 /usr/local/bin/prometheus-wireguard-exporter
chmod +x /usr/local/bin/prometheus-wireguard-exporter
```

```ini
# /etc/systemd/system/prometheus-wireguard-exporter.service
[Unit]
Description=Prometheus WireGuard Exporter
After=network.target

[Service]
Type=simple
User=root
ExecStart=/usr/local/bin/prometheus-wireguard-exporter \
  -a 0.0.0.0:9586 \
  -n
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Key metrics exported:

```
# Handshake age (seconds since last handshake — should be < 180s for active peers)
wireguard_latest_handshake_seconds{interface="wg0",public_key="<key>"}

# Bytes transferred
wireguard_sent_bytes_total{interface="wg0",public_key="<key>"}
wireguard_received_bytes_total{interface="wg0",public_key="<key>"}

# Allowed IPs count
wireguard_allowed_ips_total{interface="wg0",public_key="<key>"}
```

### Alerting Rules

```yaml
groups:
  - name: wireguard
    rules:
      - alert: WireGuardPeerHandshakeStale
        expr: |
          (time() - wireguard_latest_handshake_seconds) > 300
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "WireGuard peer handshake stale on {{ $labels.instance }}"
          description: "Peer {{ $labels.public_key }} on {{ $labels.interface }} has not handshaked for {{ $value | humanizeDuration }}"

      - alert: WireGuardPeerDown
        expr: |
          (time() - wireguard_latest_handshake_seconds) > 600
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "WireGuard peer is down on {{ $labels.instance }}"

      - alert: WireGuardInterfaceDown
        expr: |
          up{job="wireguard"} == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "WireGuard exporter unreachable on {{ $labels.instance }}"
```

### Shell-Based Health Check Script

```bash
#!/usr/bin/env bash
# /usr/local/bin/wg-health-check.sh
# Checks all WireGuard peers and reports stale handshakes

set -euo pipefail

STALE_THRESHOLD=180  # seconds
CRITICAL_THRESHOLD=300

check_interface() {
    local iface="$1"

    if ! ip link show "$iface" &>/dev/null; then
        echo "CRITICAL: Interface $iface not found"
        return 2
    fi

    local exit_code=0
    while IFS= read -r line; do
        if [[ "$line" =~ ^peer:\ (.+)$ ]]; then
            current_peer="${BASH_REMATCH[1]}"
        elif [[ "$line" =~ ^[[:space:]]+latest\ handshake:\ (.+)$ ]]; then
            handshake_str="${BASH_REMATCH[1]}"
            if [[ "$handshake_str" == "(never)" ]]; then
                echo "WARNING: Peer ${current_peer:0:8}... has never handshaked on $iface"
                exit_code=$((exit_code < 1 ? 1 : exit_code))
                continue
            fi
            # Parse handshake age
            handshake_epoch=$(date -d "$handshake_str" +%s 2>/dev/null || echo 0)
            now=$(date +%s)
            age=$((now - handshake_epoch))

            if [[ $age -gt $CRITICAL_THRESHOLD ]]; then
                echo "CRITICAL: Peer ${current_peer:0:8}... handshake age ${age}s on $iface"
                exit_code=2
            elif [[ $age -gt $STALE_THRESHOLD ]]; then
                echo "WARNING: Peer ${current_peer:0:8}... handshake age ${age}s on $iface"
                exit_code=$((exit_code < 1 ? 1 : exit_code))
            fi
        fi
    done < <(wg show "$iface" dump | awk 'NR>1 {print "peer: " $1 "\n  latest handshake: " $5}')

    if [[ $exit_code -eq 0 ]]; then
        echo "OK: All peers on $iface are healthy"
    fi
    return $exit_code
}

# Check all WireGuard interfaces
for iface in $(wg show interfaces); do
    check_interface "$iface"
done
```

## Section 7: IP Routing and Kernel Parameter Tuning

### Required Kernel Parameters for Gateway Nodes

```bash
# /etc/sysctl.d/99-wireguard-gateway.conf

# Enable IP forwarding for both IPv4 and IPv6
net.ipv4.ip_forward = 1
net.ipv6.conf.all.forwarding = 1

# Increase UDP buffer sizes for high-throughput tunnels
net.core.rmem_max = 134217728
net.core.wmem_max = 134217728
net.core.rmem_default = 16777216
net.core.wmem_default = 16777216

# Increase connection tracking table size
net.netfilter.nf_conntrack_max = 1048576

# Reduce TIME_WAIT connections
net.ipv4.tcp_tw_reuse = 1

# Increase ARP cache size for large mesh networks
net.ipv4.neigh.default.gc_thresh1 = 4096
net.ipv4.neigh.default.gc_thresh2 = 8192
net.ipv4.neigh.default.gc_thresh3 = 16384
```

Apply:

```bash
sysctl --system
```

### MSS Clamping for Tunneled Traffic

WireGuard adds 60 bytes of overhead (IPv4) or 80 bytes (IPv6) to each packet. Without MSS clamping, TCP connections through the tunnel will have packets fragmented or dropped:

```bash
# Clamp MSS for traffic entering and leaving the WireGuard interface
# IPv4: Standard MTU 1500 - 60 bytes WireGuard overhead - 20 bytes IP - 20 bytes TCP = 1400
iptables -t mangle -A FORWARD -i wg0 -p tcp --tcp-flags SYN,RST SYN \
  -j TCPMSS --set-mss 1380

iptables -t mangle -A FORWARD -o wg0 -p tcp --tcp-flags SYN,RST SYN \
  -j TCPMSS --set-mss 1380

# For IPv6
ip6tables -t mangle -A FORWARD -i wg0 -p tcp --tcp-flags SYN,RST SYN \
  -j TCPMSS --set-mss 1360

ip6tables -t mangle -A FORWARD -o wg0 -p tcp --tcp-flags SYN,RST SYN \
  -j TCPMSS --set-mss 1360
```

Set MTU explicitly in the interface configuration:

```ini
[Interface]
Address = 10.200.0.1/24
ListenPort = 51820
PrivateKey = <private-key>
# Explicit MTU to prevent fragmentation
MTU = 1420
```

## Section 8: Key Rotation Procedures

WireGuard keys should be rotated periodically. The process is zero-downtime when done correctly.

### Manual Key Rotation

```bash
#!/usr/bin/env bash
# rotate-wg-key.sh — Rotate WireGuard keys with zero-downtime
# Requires that the new public key is distributed to peers before cutting over

set -euo pipefail

INTERFACE="wg0"
BACKUP_DIR="/etc/wireguard/key-backup/$(date +%Y%m%d)"
mkdir -p "$BACKUP_DIR"

# Backup current keys
cp /etc/wireguard/private.key "$BACKUP_DIR/private.key.bak"
cp /etc/wireguard/public.key "$BACKUP_DIR/public.key.bak"

# Generate new keys
NEW_PRIVATE=$(wg genkey)
NEW_PUBLIC=$(echo "$NEW_PRIVATE" | wg pubkey)

echo "New public key: $NEW_PUBLIC"
echo ""
echo "MANUAL STEP: Distribute the new public key to ALL peers before continuing."
echo "Each peer must update their [Peer] section to reference the new public key."
echo ""
read -p "Have all peers been updated? (yes/no): " confirm

if [[ "$confirm" != "yes" ]]; then
    echo "Aborting key rotation."
    exit 1
fi

# Write new private key
echo "$NEW_PRIVATE" > /etc/wireguard/private.key
chmod 600 /etc/wireguard/private.key
echo "$NEW_PUBLIC" > /etc/wireguard/public.key

# Hot-reload the private key without bringing down the interface
wg set "$INTERFACE" private-key /etc/wireguard/private.key

echo "Key rotation complete. Interface $INTERFACE updated with new private key."
echo "Peer handshakes will re-establish within the next 180 seconds."
```

### Automated Rotation with Vault

```bash
# Store WireGuard keys in HashiCorp Vault
vault kv put secret/wireguard/cluster-a \
  private_key="$(wg genkey | tee /tmp/wg_priv)" \
  public_key="$(wg pubkey < /tmp/wg_priv)"
rm /tmp/wg_priv

# Retrieve and write at boot
vault kv get -field=private_key secret/wireguard/cluster-a > /etc/wireguard/private.key
chmod 600 /etc/wireguard/private.key
```

## Section 9: Troubleshooting WireGuard

### Diagnostic Commands

```bash
# Full interface dump: keys, peers, endpoints, allowed IPs, latest handshake, traffic
wg show wg0

# Show just endpoint information
wg show wg0 endpoints

# Show allowed IPs
wg show wg0 allowed-ips

# Show latest handshakes (epoch timestamp)
wg show wg0 latest-handshakes

# Check if WireGuard UDP port is listening
ss -ulnp | grep 51820

# Verify routing table includes WireGuard routes
ip route show table main | grep wg0

# Verify iptables rules are in place
iptables -L FORWARD -n -v | grep wg0
iptables -t nat -L POSTROUTING -n -v

# Packet capture on WireGuard interface (encrypted at this point)
tcpdump -i wg0 -n

# Capture on physical interface (will show encrypted UDP packets)
tcpdump -i eth0 -n udp port 51820
```

### Common Issues

**Peers not handshaking:**
1. Verify UDP port 51820 is open in the firewall on both sides
2. Check that the `Endpoint` IP/hostname resolves correctly
3. Verify the public key in the peer's config matches the actual public key

```bash
# Verify remote endpoint is reachable
nc -u -v 203.0.113.50 51820

# Manually force a handshake attempt
wg show wg0 latest-handshakes
# If timestamp is old, check firewall rules on both ends
```

**Traffic not flowing through tunnel:**
1. Verify `AllowedIPs` covers the destination network
2. Check IP forwarding is enabled on gateway nodes
3. Verify iptables FORWARD chain is not blocking traffic

```bash
# Test tunnel connectivity
ping -I wg0 10.200.0.2

# Trace route through tunnel
traceroute -i wg0 192.168.2.1

# Check if packet is leaving the tunnel interface
tcpdump -i wg0 host 192.168.2.1
```

**High latency through tunnel:**
1. Check for MTU mismatches causing fragmentation
2. Verify `PersistentKeepalive` is set for NAT-traversal scenarios
3. Test raw WireGuard throughput to rule out CPU bottleneck

```bash
# MTU path discovery
ping -M do -s 1400 10.200.0.2
# Reduce size until ping succeeds to find effective MTU

# Throughput test
iperf3 -s &  # on remote peer
iperf3 -c 10.200.0.2 -t 30 -P 4  # on local side
```

WireGuard's simplicity is its greatest operational strength. A single interface, a handful of configuration parameters, and a clean cryptographic model make it significantly easier to audit and troubleshoot than IPsec or OpenVPN in equivalent deployments.
