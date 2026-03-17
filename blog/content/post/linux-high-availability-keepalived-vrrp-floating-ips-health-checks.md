---
title: "Linux High Availability with Keepalived: VRRP for Floating IPs and Health Checks"
date: 2031-02-07T00:00:00-05:00
draft: false
tags: ["Linux", "High Availability", "Keepalived", "VRRP", "Networking", "Load Balancing", "Kubernetes", "MetalLB"]
categories:
- Linux
- Networking
- High Availability
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to Keepalived and VRRP: configuring master/backup pairs, writing health check scripts, implementing non-preemptive failover, comparing with Kubernetes MetalLB, and designing multi-site VRRP topologies for production HA."
more_link: "yes"
url: "/linux-high-availability-keepalived-vrrp-floating-ips-health-checks/"
---

Keepalived implements the Virtual Router Redundancy Protocol (VRRP) to provide floating IP addresses that automatically migrate between servers when a failure is detected. It is the backbone of high-availability networking for traditional Linux servers, bare-metal load balancers, and Kubernetes clusters not running on cloud providers. This guide covers the complete Keepalived implementation — from basic master/backup pairs through advanced multi-site topologies.

<!--more-->

# Linux High Availability with Keepalived: VRRP for Floating IPs and Health Checks

## Section 1: VRRP Protocol Fundamentals

VRRP (RFC 5798) solves the single-point-of-failure problem for default gateways and service IPs:

```
Without VRRP:
┌──────────────┐     ┌──────────────┐
│   Server A   │     │   Server B   │
│  192.168.1.10│     │  192.168.1.11│
└──────┬───────┘     └──────────────┘
       │ (single point of failure)
  192.168.1.10 (service IP)

With VRRP:
┌──────────────┐     ┌──────────────┐
│   Server A   │VRRP │   Server B   │
│  192.168.1.10│◄────│  192.168.1.11│
│ [MASTER]     │     │ [BACKUP]     │
└──────┬───────┘     └──────┬───────┘
       │                     │
  192.168.1.100 (Virtual IP — floats to healthy master)
```

### VRRP Election Process

1. Each VRRP router has a **priority** (1-254; 255 is reserved for the IP owner)
2. The router with the highest priority becomes the **Master**
3. The Master sends VRRP advertisements (multicast to 224.0.0.18) every **advert_int** seconds
4. If Backups miss **advert_int × 3 + skew** advertisements, they assume the Master failed
5. The Backup with the highest priority transitions to Master and assigns the virtual IP

### Key Timers

```
Skew time = (256 - priority) / 256 seconds
Master down interval = 3 × advert_int + skew_time
Default advert_int = 1 second
Default master_down = ~3.2 seconds for priority 100
```

## Section 2: Installing and Configuring Keepalived

### Installation

```bash
# RHEL/CentOS/Rocky Linux 9
dnf install -y keepalived

# Ubuntu/Debian
apt-get install -y keepalived

# Enable at boot
systemctl enable keepalived

# Verify version
keepalived --version
# Keepalived v2.3.1 (01/30,2031)
```

### Basic Master/Backup Configuration

```bash
# /etc/keepalived/keepalived.conf — SERVER A (Master)
global_defs {
    # Unique identifier for this node
    router_id server-a

    # Enable script security (prevents arbitrary code execution)
    script_security

    # Email notification (configure SMTP if desired)
    notification_email {
        ops@company.com
    }
    notification_email_from keepalived@server-a.company.com
    smtp_server 10.0.0.1
    smtp_connect_timeout 30

    # Enable BFD for faster failure detection (optional)
    enable_bfd
}

vrrp_instance VI_1 {
    state MASTER
    interface eth0          # The physical interface VRRP uses
    virtual_router_id 51    # Must be unique per VRRP group (1-255)
    priority 110            # Higher = preferred master
    advert_int 1            # Advertisement interval in seconds

    # Authentication (same on all routers in the group)
    authentication {
        auth_type PASS
        auth_pass superSecretPass2031   # Max 8 chars
    }

    # The virtual IP address(es) this group manages
    virtual_ipaddress {
        192.168.1.100/24 dev eth0 label eth0:vip
        192.168.1.101/24 dev eth0 label eth0:vip2   # Multiple VIPs allowed
    }

    # Unicast peers — use instead of multicast for routed environments
    # (comment out if on same L2 segment with multicast support)
    unicast_src_ip 192.168.1.10    # This node's IP
    unicast_peer {
        192.168.1.11               # Peer node IP
    }

    # Track interface health
    track_interface {
        eth1 weight 5    # Demote priority by 5 if eth1 goes down
    }
}
```

```bash
# /etc/keepalived/keepalived.conf — SERVER B (Backup)
global_defs {
    router_id server-b
    script_security
}

vrrp_instance VI_1 {
    state BACKUP           # Initial state
    interface eth0
    virtual_router_id 51   # Must match Master
    priority 100           # Lower than Master
    advert_int 1

    authentication {
        auth_type PASS
        auth_pass superSecretPass2031
    }

    virtual_ipaddress {
        192.168.1.100/24 dev eth0 label eth0:vip
        192.168.1.101/24 dev eth0 label eth0:vip2
    }

    unicast_src_ip 192.168.1.11
    unicast_peer {
        192.168.1.10
    }

    track_interface {
        eth1 weight 5
    }
}
```

### Starting and Verifying VRRP

```bash
# Start keepalived
systemctl start keepalived

# Verify VIP is assigned on the master
ip addr show eth0
# 2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500
#     inet 192.168.1.10/24 brd 192.168.1.255 scope global eth0
#     inet 192.168.1.100/24 brd 192.168.1.255 scope global secondary eth0:vip

# Check keepalived status
systemctl status keepalived

# Monitor state changes in real-time
journalctl -fu keepalived

# Detailed VRRP state with keepalived's built-in SIGUSR1
kill -SIGUSR1 $(cat /var/run/keepalived.pid)
cat /tmp/keepalived.stats

# Verify using ip route
ip route get 192.168.1.100
```

## Section 3: Health Check Scripts

The real power of Keepalived is triggering failover based on application health, not just network connectivity.

### VRRP Script Framework

```bash
# /etc/keepalived/keepalived.conf — with health checks

global_defs {
    router_id lb-01
    script_security
    script_user keepalived_script  # Run scripts as this user, not root
}

# Define the check script
vrrp_script check_nginx {
    script "/etc/keepalived/scripts/check-nginx.sh"
    interval 2      # Run every 2 seconds
    timeout 3       # Kill script if it takes longer than 3s
    rise 2          # 2 consecutive successes to declare UP
    fall 2          # 2 consecutive failures to declare DOWN
    weight -20      # Subtract 20 from priority when DOWN
}

vrrp_script check_backend_health {
    script "/etc/keepalived/scripts/check-backend.sh"
    interval 5
    timeout 10
    rise 1
    fall 3
    weight -30      # Larger penalty = more aggressive failover
}

vrrp_instance VI_HTTP {
    state MASTER
    interface eth0
    virtual_router_id 51
    priority 110
    advert_int 1

    authentication {
        auth_type PASS
        auth_pass httpPass2031
    }

    virtual_ipaddress {
        10.0.0.100/24
    }

    unicast_src_ip 10.0.0.10
    unicast_peer {
        10.0.0.11
    }

    # Track the scripts defined above
    track_script {
        check_nginx
        check_backend_health
    }

    # Notification scripts (run as root — be careful)
    notify_master "/etc/keepalived/scripts/notify.sh MASTER"
    notify_backup "/etc/keepalived/scripts/notify.sh BACKUP"
    notify_fault  "/etc/keepalived/scripts/notify.sh FAULT"
    notify        "/etc/keepalived/scripts/notify-all.sh"
}
```

### Health Check Script Library

```bash
#!/bin/bash
# /etc/keepalived/scripts/check-nginx.sh
# Check if nginx is running and responding

set -euo pipefail

# Check 1: Process running
if ! pidof nginx > /dev/null 2>&1; then
    echo "FAIL: nginx process not found"
    exit 1
fi

# Check 2: HTTP response
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    --connect-timeout 2 \
    --max-time 3 \
    http://127.0.0.1/nginx_status 2>/dev/null || echo "000")

if [ "$HTTP_CODE" != "200" ]; then
    echo "FAIL: nginx status returned HTTP $HTTP_CODE"
    exit 1
fi

exit 0
```

```bash
#!/bin/bash
# /etc/keepalived/scripts/check-haproxy.sh
# Comprehensive HAProxy health check

set -euo pipefail

HAPROXY_STATS_SOCKET="/var/run/haproxy/stats.sock"
MIN_ACTIVE_BACKENDS=1

# Check HAProxy process
if ! systemctl is-active --quiet haproxy; then
    echo "FAIL: haproxy service is not active"
    exit 1
fi

# Check stats socket is accessible
if [ ! -S "$HAPROXY_STATS_SOCKET" ]; then
    echo "FAIL: stats socket not found at $HAPROXY_STATS_SOCKET"
    exit 1
fi

# Check that at least MIN_ACTIVE_BACKENDS backends are UP
# Using HAProxy stats socket
ACTIVE_BACKENDS=$(echo "show stat" | \
    socat - "$HAPROXY_STATS_SOCKET" 2>/dev/null | \
    awk -F',' '$18 == "UP" { count++ } END { print count+0 }')

if [ "$ACTIVE_BACKENDS" -lt "$MIN_ACTIVE_BACKENDS" ]; then
    echo "FAIL: only $ACTIVE_BACKENDS backends UP (minimum: $MIN_ACTIVE_BACKENDS)"
    exit 1
fi

echo "OK: $ACTIVE_BACKENDS backends UP"
exit 0
```

```bash
#!/bin/bash
# /etc/keepalived/scripts/check-database-replica.sh
# Check PostgreSQL replication lag

set -euo pipefail

MAX_LAG_BYTES=10485760    # 10MB lag threshold
PGHOST="localhost"
PGPORT="5432"
PGUSER="monitoring"
PGDATABASE="postgres"

# Check replication status
REPLICATION_STATUS=$(PGPASSWORD="$MONITORING_PASSWORD" psql \
    -h "$PGHOST" -p "$PGPORT" \
    -U "$PGUSER" -d "$PGDATABASE" \
    -t -c "SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)
           FROM pg_stat_replication
           LIMIT 1;" 2>/dev/null)

if [ -z "$REPLICATION_STATUS" ]; then
    # This node might be the primary — check
    IS_PRIMARY=$(PGPASSWORD="$MONITORING_PASSWORD" psql \
        -h "$PGHOST" -p "$PGPORT" \
        -U "$PGUSER" -d "$PGDATABASE" \
        -t -c "SELECT NOT pg_is_in_recovery();" 2>/dev/null | tr -d ' ')

    if [ "$IS_PRIMARY" = "t" ]; then
        exit 0  # Primary is always healthy for this check
    fi
    echo "FAIL: unable to determine replication status"
    exit 1
fi

LAG_BYTES=$(echo "$REPLICATION_STATUS" | tr -d ' ')

if [ "$LAG_BYTES" -gt "$MAX_LAG_BYTES" ]; then
    echo "FAIL: replication lag ${LAG_BYTES} bytes exceeds threshold ${MAX_LAG_BYTES}"
    exit 1
fi

echo "OK: replication lag ${LAG_BYTES} bytes"
exit 0
```

### Notification Scripts

```bash
#!/bin/bash
# /etc/keepalived/scripts/notify-all.sh
# Called on all state transitions with: <type> <name> <state>

set -euo pipefail

TYPE="$1"    # INSTANCE or GROUP
NAME="$2"    # Instance or group name
STATE="$3"   # MASTER, BACKUP, or FAULT

HOSTNAME=$(hostname -f)
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
LOG_FILE="/var/log/keepalived-transitions.log"

# Log the transition
echo "[$TIMESTAMP] $HOSTNAME: $NAME transitioned to $STATE" | tee -a "$LOG_FILE"

# Send to syslog
logger -t keepalived "VRRP ${TYPE} ${NAME} on ${HOSTNAME} transitioned to ${STATE}"

# Update Prometheus metric via pushgateway
if command -v curl &>/dev/null; then
    PROM_STATE=0
    [ "$STATE" = "MASTER" ] && PROM_STATE=1

    cat <<EOF | curl -s --data-binary @- \
        "${PROMETHEUS_PUSHGATEWAY:-http://pushgateway:9091}/metrics/job/keepalived/instance/${NAME}/host/${HOSTNAME}"
# HELP keepalived_vrrp_state VRRP state (1=MASTER, 0=BACKUP/FAULT)
# TYPE keepalived_vrrp_state gauge
keepalived_vrrp_state{instance="${NAME}",state="${STATE}"} ${PROM_STATE}
EOF
fi

# Page on-call if this is a FAULT state
if [ "$STATE" = "FAULT" ]; then
    # Send PagerDuty alert
    if [ -n "${PAGERDUTY_KEY:-}" ]; then
        curl -s -X POST \
            -H "Content-Type: application/json" \
            -d "{
                \"routing_key\": \"${PAGERDUTY_KEY}\",
                \"event_action\": \"trigger\",
                \"payload\": {
                    \"summary\": \"Keepalived FAULT: ${NAME} on ${HOSTNAME}\",
                    \"severity\": \"critical\",
                    \"source\": \"${HOSTNAME}\",
                    \"custom_details\": {
                        \"instance\": \"${NAME}\",
                        \"state\": \"${STATE}\",
                        \"timestamp\": \"${TIMESTAMP}\"
                    }
                }
            }" \
            "https://events.pagerduty.com/v2/enqueue"
    fi
fi

# Optionally reload services on MASTER transition
if [ "$STATE" = "MASTER" ] && [ "$NAME" = "VI_HTTP" ]; then
    # Ensure nginx is started on this node when it becomes master
    systemctl start nginx 2>/dev/null || true
fi
```

## Section 4: Non-Preemptive Failover

By default, when a failed Master recovers, it reclaims the VIP (preemption). For production services, non-preemptive mode is often preferable — avoiding unnecessary state transitions:

```bash
vrrp_instance VI_1 {
    state BACKUP          # Both nodes start as BACKUP with nopreempt
    interface eth0
    virtual_router_id 51
    priority 110          # Still different priorities for initial election
    advert_int 1

    # Disable preemption — recovered nodes do NOT reclaim mastership
    nopreempt

    # Optional: preemption delay (wait N seconds before preempting)
    # preempt_delay 300   # Wait 5 minutes before preempting

    authentication {
        auth_type PASS
        auth_pass nopreemptPass2031
    }

    virtual_ipaddress {
        10.0.0.100/24
    }

    unicast_src_ip 10.0.0.10
    unicast_peer {
        10.0.0.11
    }
}
```

With `nopreempt`:
1. Node A starts first → becomes Master (highest priority wins initial election)
2. Node A fails → Node B becomes Master
3. Node A recovers → Node B **remains** Master (no unnecessary failover)
4. If Node B fails → Node A becomes Master again

### Preempt Delay for Warm-up Scenarios

```bash
vrrp_instance VI_1 {
    state MASTER
    interface eth0
    virtual_router_id 51
    priority 110
    advert_int 1

    # If this node recovers, wait 60 seconds before reclaiming
    # Allows services (nginx, app server) time to warm up
    preempt_delay 60

    authentication {
        auth_type PASS
        auth_pass warmupPass2031
    }

    virtual_ipaddress {
        10.0.0.100/24
    }
}
```

## Section 5: Virtual Server Load Balancing (LVS Integration)

Keepalived also integrates with Linux Virtual Server (LVS) for Layer 4 load balancing:

```bash
# /etc/keepalived/keepalived.conf — LVS load balancer config

global_defs {
    router_id lvs-01
    script_security
}

vrrp_instance VI_LVS {
    state MASTER
    interface eth0
    virtual_router_id 52
    priority 110
    advert_int 1

    authentication {
        auth_type PASS
        auth_pass lvsPass2031
    }

    virtual_ipaddress {
        10.0.0.200/24
    }

    unicast_src_ip 10.0.0.10
    unicast_peer {
        10.0.0.11
    }
}

# Virtual server definition
virtual_server 10.0.0.200 80 {
    delay_loop 6          # Health check every 6 seconds
    lb_algo wrr           # Weighted Round Robin
    lb_kind NAT           # NAT mode (DR = Direct Routing, TUN = Tunneling)
    persistence_timeout 50  # Connection persistence seconds
    protocol TCP

    # Real server definitions with health checks
    real_server 10.0.0.20 80 {
        weight 3          # Higher weight = more connections
        HTTP_GET {
            url {
                path /health
                status_code 200
            }
            connect_timeout 3
            nb_get_retry 3
            delay_before_retry 3
        }
    }

    real_server 10.0.0.21 80 {
        weight 2
        HTTP_GET {
            url {
                path /health
                status_code 200
            }
            connect_timeout 3
            nb_get_retry 3
            delay_before_retry 3
        }
    }

    real_server 10.0.0.22 80 {
        weight 1
        # TCP health check for non-HTTP services
        TCP_CHECK {
            connect_timeout 3
            retry 3
            delay_before_retry 3
        }
    }
}
```

## Section 6: Kubernetes MetalLB vs. Keepalived

When running Kubernetes on bare metal, both MetalLB and Keepalived (via keepalived-operator) are viable for providing external LoadBalancer IPs:

### MetalLB Architecture

```yaml
# MetalLB Layer 2 mode — similar to VRRP
apiVersion: metallb.io/v1beta1
kind: L2Advertisement
metadata:
  name: l2-advertisement
  namespace: metallb-system
spec:
  ipAddressPools:
    - first-pool
  interfaces:
    - eth0

---
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: first-pool
  namespace: metallb-system
spec:
  addresses:
    - 192.168.1.150-192.168.1.200  # Pool of external IPs
```

```yaml
# MetalLB BGP mode — for proper HA with multiple paths
apiVersion: metallb.io/v1beta2
kind: BGPPeer
metadata:
  name: tor-switch
  namespace: metallb-system
spec:
  myASN: 65001
  peerASN: 65000
  peerAddress: 192.168.1.1
  peerPort: 179

---
apiVersion: metallb.io/v1beta1
kind: BGPAdvertisement
metadata:
  name: bgp-advertisement
  namespace: metallb-system
spec:
  ipAddressPools:
    - first-pool
  aggregationLength: 32
  localPref: 100
  communities:
    - 65535:65282  # no-export
```

### Comparison Matrix

| Feature | MetalLB L2 | MetalLB BGP | Keepalived |
|---|---|---|---|
| Protocol | ARP/NDP (similar to VRRP) | BGP | VRRP |
| Failover time | 2-3 seconds | Sub-second | ~3 seconds |
| Multiple paths | No | Yes | No |
| Kubernetes-native | Yes | Yes | Via operator |
| Network requirements | L2 adjacency | BGP router | L2 adjacency or unicast |
| Complexity | Low | High | Medium |
| OS-level VIPs | No | No | Yes |
| Non-K8s services | No | No | Yes |

### When to Use Keepalived with Kubernetes

Keepalived is still the right choice when:
1. You need VIPs for non-Kubernetes services (HAProxy, nginx, database clusters)
2. You need faster failover via custom health checks
3. Your infrastructure team manages load balancers outside the Kubernetes control plane
4. You need VIPs at the OS level (e.g., for the Kubernetes API server itself)

```yaml
# keepalived-operator deployment for Kubernetes
# github.com/redhat-cop/keepalived-operator
apiVersion: v1
kind: Namespace
metadata:
  name: keepalived-operator
---
apiVersion: operators.coreos.com/v1alpha1
kind: Subscription
metadata:
  name: keepalived-operator
  namespace: keepalived-operator
spec:
  channel: alpha
  name: keepalived-operator
  source: community-operators
  sourceNamespace: openshift-marketplace
```

```yaml
# KeepalivedGroup — manages keepalived instances on nodes
apiVersion: redhatcop.redhat.io/v1alpha1
kind: KeepalivedGroup
metadata:
  name: ha-group
  namespace: keepalived-operator
spec:
  image: registry.redhat.io/openshift4/ose-keepalived-ipfailover
  interface: eth0
  nodeSelector:
    matchLabels:
      node-role.kubernetes.io/worker: ""
  verbosity: 1
  blacklistRouterIDs: [1, 2]  # Reserve these VRRP IDs for manual use
---
# Service annotation to get a VIP from keepalived
apiVersion: v1
kind: Service
metadata:
  name: my-lb-service
  annotations:
    keepalived-operator.redhatcop.io/keepalivedgroup: keepalived-operator/ha-group
spec:
  type: LoadBalancer
  loadBalancerIP: 192.168.1.150
  ports:
    - port: 80
      targetPort: 8080
  selector:
    app: my-app
```

## Section 7: Multi-Site VRRP Topology

For geographically distributed deployments:

```
Site A (Primary DC)                Site B (DR DC)
┌─────────────────────┐           ┌─────────────────────┐
│  LB-A1: priority 110│           │  LB-B1: priority 90 │
│  LB-A2: priority 100│  WAN Link │  LB-B2: priority 80 │
│  VIP: 10.0.1.100   │◄─────────►│  VIP: 10.0.2.100   │
└─────────────────────┘           └─────────────────────┘
        │                                  │
    DNS: app.company.com               DNS: app-dr.company.com
    Primary (low TTL)                  Failover (GTM)
```

### Multi-Instance VRRP Configuration

```bash
# /etc/keepalived/keepalived.conf — LB-A1 (highest priority)

global_defs {
    router_id lb-a1
    script_security
    # Enable SNMP for monitoring
    enable_snmp_keepalived
    enable_snmp_rfcv2
    enable_snmp_rfcv3
}

vrrp_script check_local_nginx {
    script "/etc/keepalived/scripts/check-nginx.sh"
    interval 2
    timeout 3
    rise 2
    fall 2
    weight -20
}

vrrp_script check_wan_connectivity {
    script "/etc/keepalived/scripts/check-wan.sh"
    interval 5
    timeout 5
    rise 1
    fall 3
    weight -40
}

# Instance 1: Local site A VIP
vrrp_instance VI_SITE_A {
    state MASTER
    interface eth0
    virtual_router_id 51
    priority 110
    advert_int 1
    nopreempt

    authentication {
        auth_type PASS
        auth_pass siteAPass2031
    }

    virtual_ipaddress {
        10.0.1.100/24 dev eth0
    }

    # Unicast to both site A peers and site B peers
    unicast_src_ip 10.0.1.10
    unicast_peer {
        10.0.1.11    # LB-A2
        10.0.2.10    # LB-B1 (across WAN — same VRRP group)
        10.0.2.11    # LB-B2
    }

    track_script {
        check_local_nginx
        check_wan_connectivity
    }

    notify "/etc/keepalived/scripts/notify-all.sh"
}
```

### WAN Connectivity Health Check

```bash
#!/bin/bash
# /etc/keepalived/scripts/check-wan.sh
# Verify WAN connectivity to internet endpoints

set -euo pipefail

WAN_CHECK_HOSTS=("8.8.8.8" "1.1.1.1" "208.67.222.222")
WAN_REQUIRED_SUCCESS=2
WAN_TIMEOUT=3

success_count=0
for host in "${WAN_CHECK_HOSTS[@]}"; do
    if ping -c 1 -W "$WAN_TIMEOUT" "$host" > /dev/null 2>&1; then
        ((success_count++)) || true
    fi
done

if [ "$success_count" -ge "$WAN_REQUIRED_SUCCESS" ]; then
    exit 0
fi

echo "FAIL: only $success_count/$WAN_REQUIRED_SUCCESS WAN probes succeeded"
exit 1
```

## Section 8: Advanced Keepalived Patterns

### Tracking BGP Route Presence

For Keepalived on nodes that also run BGP, fail over when the BGP route disappears:

```bash
#!/bin/bash
# /etc/keepalived/scripts/check-bgp-route.sh
# Check if default route is present via BGP

REQUIRED_ROUTE="0.0.0.0/0"
BGP_SOURCE_PROTOCOL="bgp"

# Check via ip route
if ip route show "$REQUIRED_ROUTE" proto bgp | grep -q "$REQUIRED_ROUTE"; then
    exit 0
fi

# Check via FRR/BIRD if installed
if command -v vtysh &>/dev/null; then
    if vtysh -c "show ip bgp summary" 2>/dev/null | grep -q "Established"; then
        exit 0
    fi
fi

echo "FAIL: BGP default route not present"
exit 1
```

### Keepalived with Network Namespaces

For Kubernetes worker nodes with multiple network namespaces:

```bash
# Run keepalived in a specific network namespace
# Useful when the VIP should be on a particular namespace

# Create keepalived config for host network
ip netns exec host-ns keepalived \
    --use-file /etc/keepalived/host-ns-keepalived.conf \
    --pid /var/run/keepalived-host-ns.pid \
    --log-detail

# Or use the vrrp_instance netns directive (keepalived 2.0+)
vrrp_instance VI_NS {
    state MASTER
    interface eth0
    virtual_router_id 53
    priority 100
    advert_int 1

    # Not directly supported — use network namespace at process level
}
```

### Multi-Process Keepalived

For systems managing many VRRP instances, split into multiple keepalived processes:

```bash
# Process 1: HTTP services (VIPs 10.0.0.100-110)
keepalived --use-file /etc/keepalived/http.conf \
    --pid /var/run/keepalived-http.pid \
    --log-facility 3

# Process 2: Database services (VIPs 10.0.0.120-130)
keepalived --use-file /etc/keepalived/db.conf \
    --pid /var/run/keepalived-db.pid \
    --log-facility 4
```

## Section 9: Monitoring Keepalived

### Prometheus Exporter

```bash
# Install keepalived_exporter
curl -L https://github.com/gen2brain/keepalived_exporter/releases/download/0.7.0/keepalived_exporter_0.7.0_linux_amd64.tar.gz \
  | tar xzf - -C /usr/local/bin keepalived_exporter

# Create systemd service
cat > /etc/systemd/system/keepalived_exporter.service <<EOF
[Unit]
Description=Keepalived Prometheus Exporter
After=keepalived.service

[Service]
Type=simple
User=prometheus
ExecStart=/usr/local/bin/keepalived_exporter
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

systemctl enable --now keepalived_exporter
```

### Grafana Dashboard Queries

```promql
# Current VRRP master state (1=MASTER, 0=BACKUP)
keepalived_vrrp_state{instance="VI_1"}

# Priority changes over time (indicates weight adjustments from failed scripts)
keepalived_vrrp_wanted_priority{instance="VI_1"}

# Number of times a script failed
keepalived_vrrp_script_status{name="check_nginx"} == 0

# Alert: no MASTER for a VRRP group
sum(keepalived_vrrp_state{instance="VI_1"}) by (instance) == 0

# Alert: state change within the last 5 minutes
changes(keepalived_vrrp_state{instance="VI_1"}[5m]) > 0
```

### Prometheus AlertManager Rules

```yaml
# keepalived-alerts.yaml
groups:
  - name: keepalived
    rules:
      - alert: KeepalivedNoMaster
        expr: |
          sum by (instance) (
            keepalived_vrrp_state{state="MASTER"}
          ) == 0
        for: 30s
        labels:
          severity: critical
        annotations:
          summary: "No VRRP master for instance {{ $labels.instance }}"
          description: "No node holds the master state for VRRP instance {{ $labels.instance }}"

      - alert: KeepalivedFrequentFailover
        expr: |
          changes(keepalived_vrrp_state[10m]) > 3
        labels:
          severity: warning
        annotations:
          summary: "Frequent VRRP state changes on {{ $labels.instance }}"
          description: "VRRP instance {{ $labels.instance }} has changed state {{ $value }} times in 10 minutes"

      - alert: KeepalivedScriptFailing
        expr: keepalived_vrrp_script_status == 0
        for: 1m
        labels:
          severity: warning
        annotations:
          summary: "Keepalived health check script failing: {{ $labels.name }}"
```

## Section 10: Troubleshooting

### Common Issues

```bash
# Issue: VIP not assigned after MASTER state
# Check IP forwarding
sysctl net.ipv4.ip_forward   # Should be 1

# Check ARP settings (needed for VIP to respond to ARP)
sysctl net.ipv4.conf.eth0.arp_ignore     # Should be 0 or 1
sysctl net.ipv4.conf.eth0.arp_announce   # Should be 0 or 2

# For LVS Direct Routing mode (backends):
sysctl net.ipv4.conf.lo.arp_ignore    # Should be 1
sysctl net.ipv4.conf.all.arp_ignore   # Should be 1

# Issue: Split-brain (both nodes think they're MASTER)
# Usually caused by unicast_peer misconfiguration or blocked VRRP traffic
# Check if VRRP multicast is reaching the backup
tcpdump -n -i eth0 proto 112   # VRRP protocol number

# Check unicast packets
tcpdump -n -i eth0 host 10.0.0.11 and proto 112

# Issue: Health check script never triggers failover
# Test the script manually as the keepalived_script user
sudo -u keepalived_script /etc/keepalived/scripts/check-nginx.sh
echo "Exit code: $?"

# Check script file permissions
ls -la /etc/keepalived/scripts/
# Must be executable and owned by keepalived_script

# Issue: Keepalived consuming too much CPU
# Reduce check frequency or use notify_master/notify_backup
# to start/stop checks based on state
```

### Keepalived Debug Mode

```bash
# Run keepalived in debug mode (foreground, verbose)
keepalived --log-detail --log-facility 7 --dont-fork

# Enable packet-level logging
keepalived --log-detail --dump-conf

# Check configuration syntax
keepalived --config-test -f /etc/keepalived/keepalived.conf
# Configuration file /etc/keepalived/keepalived.conf parsed successfully

# View live VRRP state
kill -SIGUSR1 $(cat /var/run/keepalived.pid)
cat /tmp/keepalived.data
cat /tmp/keepalived.stats
```

Keepalived remains the gold standard for providing floating IPs in traditional Linux environments and complements Kubernetes MetalLB where OS-level VIPs are needed. The combination of VRRP for fast L3 failover, flexible health check scripts, and non-preemptive mode gives production teams precise control over when and how service VIPs migrate between nodes.
