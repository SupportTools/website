---
title: "Cilium 1.19 Upgrade Traps on RKE2: VLAN Sub-Interface Node IPs and Pinned bpffs Links That Keep a Node Dark"
date: 2026-10-21T09:00:00-05:00
draft: false
tags: ["Cilium", "RKE2", "Kubernetes", "eBPF", "Networking", "VLAN", "Linux Bridge", "br_netfilter", "Troubleshooting", "KubeVirt"]
categories:
- Kubernetes
- Networking
- Troubleshooting
author: "Matthew Mattox - mmattox@support.tools"
description: "Two Cilium v1.19.6 upgrade traps on RKE2: host traffic dropped when the node IP sits on a VLAN sub-interface, and pinned tcx links in bpffs that keep a node dark after rke2-killall.sh."
more_link: "yes"
url: "/cilium-1-19-vlan-subinterface-node-ip-pinned-bpffs-tcx-links-rke2/"
---

A Cilium minor upgrade on a bare-metal RKE2 cluster is normally a non-event: bump the chart version in the `HelmChartConfig`, watch the DaemonSet roll one node at a time, move on. During a v1.18.1 to v1.19.6 upgrade, two worker nodes dropped off the network completely about half a minute after their new agent started. No SSH, no ping on IPv4 or IPv6, kubelet flapping `NotReady`. Every other node upgraded cleanly.

Two separate problems stacked on top of each other. The first: Cilium v1.19.6 drops all host traffic on a node whose IP lives directly on a VLAN sub-interface such as `bond0.100`, a layout that worked on v1.18. The second turned a ten-minute fix into an hour of console work: stopping RKE2 and running `rke2-killall.sh` did **not** bring the node back, because Cilium's datapath programs are attached as **tcx links pinned in bpffs**, and pinned links outlive every process that created them. This post covers both traps, the network layout that fixed the first one, the `br_netfilter` regression that layout introduced, the exact cleanup for the second, and the pre-upgrade audit that would have caught all of it.

<!--more-->

## The Environment

The cluster runs RKE2 with Cilium as the bundled CNI, configured through a `HelmChartConfig` in `kube-system`. Nodes are bare-metal servers with two NICs bonded with LACP into `bond0`. The node network is a tagged VLAN on that bond. Most nodes also host KubeVirt virtual machines with bridge binding, so their node IP sits on a Linux bridge, `br0`, whose single port is the VLAN sub-interface:

```text
eno1 ─┐
      ├─ bond0 (802.3ad, no address) ── bond0.100 (VLAN 100) ── br0 (node IP)
eno2 ─┘
```

Two nodes were different. They had no VMs, so when they were built nobody gave them a bridge. Their node IP sat directly on the VLAN sub-interface:

```text
eno1 ─┐
      ├─ bond0 (802.3ad, no address) ── bond0.100 (VLAN 100, node IP)
eno2 ─┘
```

Both layouts are completely ordinary Linux networking, and both had run under Cilium v1.18 for months. The second layout was simply nonstandard for this fleet, and nothing flagged it.

## How Cilium Treats VLAN Traffic

Understanding the failure requires two pieces of Cilium behavior that are easy to forget until they bite.

**Device selection skips anything with a master.** Cilium attaches its host datapath programs (`bpf_host`, entry points such as `cil_from_netdev` and `cil_to_netdev`) to the devices in its `devices` list. Wildcards like `bond+` or `en+` match by name, but Cilium excludes devices that are enslaved to another device. Bridge ports and bond members are never Cilium devices, even when their names match.

**Tagged frames are dropped by default.** The program attached to a physical device drops 802.1Q-tagged frames unless the VLAN belongs to a device Cilium manages or the VLAN ID is listed in `vlan-bpf-bypass`. This is a deliberate security default: Cilium does not want unknown VLANs bypassing policy on its devices.

Put those together for the bridge layout. `br0` holds the node IP, so it is a Cilium device. `bond0` matches `bond+`, so it is a Cilium device too. `bond0.100` is a port of `br0`, so it has a master and is excluded. VLAN 100 is therefore unknown to Cilium, and `bpf_host` on `bond0` drops every tagged VLAN 100 frame. That is all node traffic. The node goes dark roughly 30 seconds after the agent starts and attaches its programs.

The bridge-over-VLAN nodes in this cluster had already hit that failure on an earlier node rebuild, which is why a `CiliumNodeConfig` granting `vlan-bpf-bypass` existed for them, selected by a node label. The nodes with the IP directly on `bond0.100` had no bridge, so they were not labeled and not covered. Under v1.18 they did not need to be.

## Trap 1: v1.19.6 Breaks the VLAN Sub-Interface Layout

The upgrade itself was an ordinary `HelmChartConfig` change. When the DaemonSet reached the first of the two nonstandard nodes, its new agent started and the node vanished. The second node had the same layout and would have followed it.

### Stop the Rollout First

The first priority when one node breaks during a CNI rollout is to stop the DaemonSet from breaking the next one. Switch the update strategy to `OnDelete`, so no further pods are replaced until an operator deletes them by hand. On RKE2, put it in the `HelmChartConfig`; a `kubectl patch` on the DaemonSet is reverted the next time the chart reconciles.

```yaml
# CLUSTER-SCOPED: apply only to the cluster being upgraded
apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata:
  name: rke2-cilium
  namespace: kube-system
spec:
  # Leave a failed chart upgrade in place for a human instead of the
  # klipper-helm default (reinstall), which uninstalls the CNI chart.
  failurePolicy: abort
  valuesContent: |-
    # Freeze the rollout: no agent pod is replaced until it is deleted by hand.
    updateStrategy:
      type: OnDelete
```

The `failurePolicy: abort` line deserves a word. klipper-helm's default for RKE2-bundled charts is `reinstall`: a failed upgrade triggers `helm uninstall` followed by a fresh install. On the CNI chart, that is a cluster-wide networking outage presented as automatic recovery. Every RKE2 `HelmChartConfig` should set `abort` explicitly.

With the rollout frozen, nodes can be advanced one at a time:

```bash
# Roll the agent on one node, then verify that node before touching the next
NODE=worker-07
kubectl -n kube-system delete pod -l k8s-app=cilium \
  --field-selector spec.nodeName="${NODE}"
kubectl -n kube-system get pods -l k8s-app=cilium -o wide \
  --field-selector spec.nodeName="${NODE}" -w
```

### The Obvious Fix Did Not Work

The documented mechanism points at an obvious fix: tell Cilium to let VLAN 100 through on those nodes. A `CiliumNodeConfig` scoped to the two affected nodes set `vlan-bpf-bypass` to the node VLAN and a second tagged VLAN they also carried:

```yaml
# Did NOT restore the nodes on v1.19.6. Kept here as the thing not to rely on.
apiVersion: cilium.io/v2
kind: CiliumNodeConfig
metadata:
  name: vlan-subif-bpf-bypass
  namespace: kube-system
spec:
  nodeSelector:
    matchLabels:
      network.support.tools/vlan-subif: "true"
  defaults:
    vlan-bpf-bypass: "100 104"
```

After an agent restart and a power cycle, neither node came back. The precise change in v1.19 that broke this layout was not bisected during the incident, and that is worth stating plainly rather than guessing at. What is known: the same bypass mechanism keeps the bridge-over-VLAN layout working on v1.19.6, and it did not rescue the sub-interface layout. The practical conclusion is to stop running the layout that broke, not to keep tuning a knob that did not help.

### The Fix: Move to the Standard Bridge Layout

The fix that worked was to make the two odd nodes look like every other node: put a `br0` on top of `bond0.100`, move the node IP to the bridge, and add the node label that the existing bridge `CiliumNodeConfig` selects.

The before state, with the node IP on the VLAN sub-interface:

```yaml
# /etc/netplan/50-cloud-init.yaml (before): node IP directly on bond0.100
network:
  version: 2
  renderer: networkd
  ethernets:
    eno1: {mtu: 1500}
    eno2: {mtu: 1500}
  bonds:
    bond0:
      interfaces: [eno1, eno2]
      mtu: 1500
      parameters:
        mode: 802.3ad
        lacp-rate: fast
        transmit-hash-policy: layer3+4
      accept-ra: false
  vlans:
    bond0.100:
      id: 100
      link: bond0
      mtu: 1500
      accept-ra: false
      addresses:
        - 192.0.2.27/24
        - 2001:db8:100::27/64
      routes:
        - {to: default, via: 192.0.2.1}
        - {to: "::/0", via: "2001:db8:100::1", on-link: true}
      nameservers:
        addresses: [192.0.2.11, 192.0.2.12]
```

The after state, matching the rest of the fleet:

```yaml
# /etc/netplan/50-cloud-init.yaml (after): br0 on bond0.100 holds the node IP
network:
  version: 2
  renderer: networkd
  ethernets:
    eno1: {mtu: 1500}
    eno2: {mtu: 1500}
  bonds:
    bond0:
      interfaces: [eno1, eno2]
      mtu: 1500
      parameters:
        mode: 802.3ad
        lacp-rate: fast
        transmit-hash-policy: layer3+4
      accept-ra: false
  vlans:
    bond0.100:
      id: 100
      link: bond0
      mtu: 1500
      # Enslaved to br0: carries no addresses and never processes RAs
      accept-ra: false
      dhcp4: false
      dhcp6: false
  bridges:
    br0:
      interfaces: [bond0.100]
      mtu: 1500
      # Single-port bridge: no STP, no forwarding delay on link up
      parameters: {stp: false, forward-delay: 0}
      accept-ra: false
      dhcp4: false
      dhcp6: false
      addresses:
        - 192.0.2.27/24
        - 2001:db8:100::27/64
      routes:
        - {to: default, via: 192.0.2.1}
        - {to: "::/0", via: "2001:db8:100::1", on-link: true}
      nameservers:
        addresses: [192.0.2.11, 192.0.2.12]
```

Keep a copy of the old file (`50-cloud-init.yaml.pre-br0`) next to the new one so a console session can revert quickly. Apply the change from a console, not over SSH on the address being moved.

The `CiliumNodeConfig` that covers every bridge-over-VLAN node is selected by label, not by hostname, so converting a node to the standard layout and labeling it is all it takes to bring it under the existing policy:

```yaml
# CLUSTER-SCOPED: one cluster only. Covers every node whose IP is on br0 over bond0.100.
apiVersion: cilium.io/v2
kind: CiliumNodeConfig
metadata:
  name: br0-vlan-bpf-bypass
  namespace: kube-system
spec:
  nodeSelector:
    matchLabels:
      network.support.tools/br0: "true"
  defaults:
    # bond0.100 is a bridge port, so it is never a Cilium device; without this,
    # bpf_host on bond0 drops every tagged VLAN 100 frame and the node goes dark.
    vlan-bpf-bypass: "100"
    # Pin the datapath devices so admin/OOB ports are never attached (see below).
    devices: "br0 bond0"
```

```bash
# Label the converted node so the bridge CiliumNodeConfig selects it
kubectl label node worker-07 network.support.tools/br0=true

# Remove the per-node experiment once nothing uses it
kubectl -n kube-system delete ciliumnodeconfig vlan-subif-bpf-bypass

# The agent reads node config only at start: restart it on this node
kubectl -n kube-system delete pod -l k8s-app=cilium \
  --field-selector spec.nodeName=worker-07
```

Verify the agent actually picked up the configuration. Do not infer it from the YAML:

```bash
POD=$(kubectl -n kube-system get pods -l k8s-app=cilium \
  --field-selector spec.nodeName=worker-07 -o jsonpath='{.items[0].metadata.name}')

# Expect the VLAN ID in the bypass list
kubectl -n kube-system exec "${POD}" -c cilium-agent -- \
  cilium-dbg config --all | grep -i vlanbpfbypass

# Expect only br0 and bond0 selected as datapath devices
kubectl -n kube-system exec "${POD}" -c cilium-agent -- \
  cilium-dbg statedb devices
```

The acceptance bar for a recovered node is that it stays reachable for more than five minutes after the agent starts and survives one full reboot with the agent enabled. The failure mode appears about 30 seconds in, so a node that answers ping for ten seconds proves nothing.

## The Regression the Fix Introduced: br_netfilter Eats VIP Traffic

Once both nodes were back on the bridge layout, LoadBalancer VIP probes started failing. Not all of them: 60 to 63 percent. The rest succeeded, which is the signature of a per-path problem rather than a dead service.

This was a known failure that had already been fixed on the other bridge nodes and was now reintroduced on the two newly converted ones. The cluster runs kube-proxy in iptables mode (Cilium's kube-proxy replacement is off), and the moment a node's IP moves onto a Linux bridge, a sysctl that never mattered before starts to matter a great deal.

### The Mechanism

With `br_netfilter` loaded and `net.bridge.bridge-nf-call-iptables=1`, frames crossing a bridge are passed through iptables while still in the bridging path. A packet arrives at the node for a LoadBalancer VIP or NodePort. kube-proxy's DNAT rule fires during `br_netfilter`'s **bridge** prerouting pass, rewriting the destination to a pod IP. If that pod lives on the same node, everything works. If the chosen endpoint is on another node, the rewritten frame has to go back out toward the network, and the only way out is the bridge port it arrived on, `bond0.100`. A Linux bridge does not forward a frame back out its ingress port (no hairpin), so the frame is dropped silently.

With N nodes behind a VIP and endpoints spread across them, roughly (N-1)/N of connections that land on a bridge node pick a remote endpoint and die. That is how a node becomes a black hole for most, but not all, of the VIP traffic it attracts as an ECMP next hop. Cilium's monitor shows no drop for the flow, because Cilium never sees it.

### Why sysctl.d Does Not Fix It

The obvious fix is a file in `/etc/sysctl.d/`. It does not survive. RKE2, like k3s, loads `br_netfilter` and writes `1` to both `bridge-nf-call-iptables` and `bridge-nf-call-ip6tables` every time the agent starts, which is after `systemd-sysctl` has applied `sysctl.d`. The value has to be set after RKE2 sets it, which means a systemd drop-in on the RKE2 unit:

```ini
# /etc/systemd/system/rke2-agent.service.d/60-bridge-nf-off.conf
# (use rke2-server.service.d on server nodes)
# RKE2 sets both keys to 1 at startup. With the node IP on br0 that drops
# off-node NodePort/LoadBalancer traffic. ExecStartPost runs after RKE2's writes.
[Service]
ExecStartPost=-/usr/sbin/sysctl -w net.bridge.bridge-nf-call-iptables=0 net.bridge.bridge-nf-call-ip6tables=0
```

```bash
# Install the drop-in, reload units, and apply the live value without restarting rke2
sudo install -d -m 0755 /etc/systemd/system/rke2-agent.service.d
sudo install -m 0644 60-bridge-nf-off.conf /etc/systemd/system/rke2-agent.service.d/
sudo systemctl daemon-reload
sudo sysctl -w net.bridge.bridge-nf-call-iptables=0 net.bridge.bridge-nf-call-ip6tables=0
```

The leading `-` on `ExecStartPost` keeps a missing sysctl from failing the unit. No RKE2 restart is required for the live value; the drop-in only matters on the next start.

### Is Turning Off Bridge Netfilter Safe?

On this kind of node, yes. Pods are attached through Cilium veths and routed, not bridged. KubeVirt bridge binding does its bridging inside each virt-launcher network namespace, which has its own sysctls. VMs attached to the host `br0` are plain L2 neighbors. Nothing on the node depends on iptables seeing bridged frames. If a node does run something that filters bridged traffic with iptables (some Docker setups, some firewall appliances on a host bridge), test it before applying this fleet-wide.

Verify the fix the same way the problem was detected: with a sample large enough to see a 1-in-N failure.

```bash
# 200 probes against the VIP; any failure means a node in the ECMP set still drops traffic
VIP=198.51.100.20
fail=0
for i in $(seq 1 200); do
  curl -s -o /dev/null --max-time 2 "http://${VIP}/healthz" || fail=$((fail + 1))
done
echo "failures: ${fail}/200"

# After the next rke2-agent restart or reboot, both values must still read 0
sysctl net.bridge.bridge-nf-call-iptables net.bridge.bridge-nf-call-ip6tables
```

If the node is a BGP speaker for the VIP, withdraw it from peering before changing anything and re-add it only after a clean 200-sample run.

## Trap 2: Pinned tcx Links Survive rke2-killall.sh

This is the part that cost the most time, and it applies to any Cilium node that the datapath itself takes off the network, regardless of the root cause.

With the first node dark, the natural recovery was: get a console, stop RKE2, run `rke2-killall.sh`, and the node's plain kernel networking should come back. It did not. `ip link` and `ip addr` looked normal, the routes were correct, and the gateway still did not answer ping.

### Why Killing the Agent Changes Nothing

On kernels with **tcx** (Linux 6.6 and later), Cilium 1.16 and newer attach their datapath programs as BPF links rather than classic `tc` filters, and pin those links in bpffs under `/sys/fs/bpf/cilium/devices/<device>/links/`. Pinning is what lets an agent restart without a traffic gap: the new agent finds the pinned links and atomically replaces the programs. In normal operation, that is a feature.

When the datapath is the thing breaking the node, the same design is a trap. A BPF link stays attached as long as anything holds a reference to it, and a pin in bpffs is a reference. Killing `cilium-agent`, stopping `rke2-agent`, and running `rke2-killall.sh` releases every process reference, but the pins remain, so `bpf_host` stays attached to `bond0` and keeps dropping tagged frames. A reboot does not help either if `rke2-agent` is enabled, because the agent starts on boot and reattaches the same programs within a minute.

`bpftool` shows what is still attached:

```bash
# tcx programs still attached to physical devices after rke2-killall.sh
bpftool net show

# The pinned links themselves
ls -R /sys/fs/bpf/cilium/devices/ | head -50
```

### The Recovery Procedure

Run this from an out-of-band console (iDRAC or IPMI serial, a KVM, or a hypervisor console), as root. The order matters: the agent must be dead before the pins are removed, or it simply recreates them.

```bash
#!/usr/bin/env bash
# Restore host networking on a node that Cilium's datapath took offline.
set -u

# 1. Stop RKE2 and keep it from starting on the next boot.
#    Use rke2-server on server nodes, k3s on k3s clusters.
systemctl disable --now rke2-agent
/usr/local/bin/rke2-killall.sh   # some installs use /opt/rke2/bin/rke2-killall.sh

# 2. Record what is still attached, for the incident notes.
bpftool net show > /root/bpf-net-before-cleanup.txt 2>&1

# 3. Remove the pinned links for EVERY device, not only the suspect one.
#    br0, bond0, the physical NICs and the cilium_* devices all carry pins.
for link in /sys/fs/bpf/cilium/devices/*/links/*; do
  [ -e "${link}" ] && rm -f "${link}"
done

# 4. Remove any classic tc attachments as well (older kernels, legacy mode).
for dev in /sys/class/net/*; do
  tc qdisc del dev "$(basename "${dev}")" clsact 2>/dev/null
done

# 5. Confirm: no cil_* programs on physical devices, and the gateway answers.
bpftool net show
ping -c 3 -W 2 192.0.2.1
```

Two details from the incident are worth emphasizing. First, removing only `bond0`'s links was not enough; the node came back only after the pins on all devices were removed. Second, host networking returned immediately after steps 3 and 4, with no reboot. If `ping` still fails at that point, the problem is not Cilium.

Then fix the cause (for the VLAN case, the bridge layout and label above) before letting RKE2 start again:

```bash
# Only after the underlying cause is fixed
systemctl enable --now rke2-agent
```

### Getting a Console in the First Place

When a node's only network path is the one Cilium just dropped, SSH is gone and the recovery lives or dies on out-of-band access. Set this up before the upgrade, not during it. On Dell servers, the iDRAC serial console (`racadm console com2`) requires the BIOS setting `SerialComm=OnConRedirCom2`, and staging that BIOS job requires a reboot. A pending firmware job such as "Apply Update From Repo" in the iDRAC job queue blocks the BIOS job until it is deleted, which is exactly the kind of discovery that should not happen mid-outage. Confirm a working serial login on every node before a CNI upgrade.

## Pinning Cilium Devices on Nodes Without a Bridge

The incident surfaced a related problem on nodes that were never at risk from the VLAN trap. The cluster-wide `devices` setting was a wildcard list, `br+ bond+ en+ eth+`. On nodes with dedicated admin or out-of-band ports (`eno3` and `eno4`, on a separate rescue network), those wildcards matched the admin ports. Cilium attached `cil_from_netdev` to them and adopted the admin address as an additional node address.

That is harmful in two ways. The rescue network is supposed to be plain kernel networking, so that it still works when Cilium does not, and attaching Cilium to it defeats the purpose. And every device that enters or leaves the selected set is a datapath reload on that node.

The bridge `CiliumNodeConfig` above already pins `devices: "br0 bond0"`. Nodes it does not cover get their own explicit list, scoped by hostname:

```yaml
# CLUSTER-SCOPED: one cluster only.
# Pin Cilium devices on nodes the br0 CiliumNodeConfig does not select, so the
# cluster-wide wildcard default stops picking up admin ports, bond members and
# Docker bridges. Restart the node's cilium pod after a change, one node at a time.
apiVersion: cilium.io/v2
kind: CiliumNodeConfig
metadata:
  name: pin-devices-storage-01
  namespace: kube-system
spec:
  nodeSelector:
    matchLabels:
      kubernetes.io/hostname: storage-01
  defaults:
    # Node IP on untagged bond0; no bridge, no VLAN
    devices: "bond0"
---
apiVersion: cilium.io/v2
kind: CiliumNodeConfig
metadata:
  name: pin-devices-office-01
  namespace: kube-system
spec:
  nodeSelector:
    matchLabels:
      kubernetes.io/hostname: office-01
  defaults:
    # Node IP on br0 over an UNTAGGED bond0: no VLAN, so no vlan-bpf-bypass needed
    devices: "br0 bond0"
```

A naming trick helps here too. An admin bond named something like `admin0` matches none of Cilium's wildcard patterns, and its member ports are enslaved and therefore excluded, so even the cluster default leaves it alone. Defense in depth: name the rescue path so Cilium cannot select it, and pin devices explicitly anyway.

One caution: do not add a device pin to a node that has no working console. A wrong `devices` value is a datapath change, and a node with no out-of-band path that loses its network is a drive to the data center.

## The Pre-Upgrade Audit That Would Have Caught This

Nothing in the cluster flagged the two nodes with a nonstandard layout. Every symptom in this post traces back to a node's network topology being invisible until a CNI upgrade changed how that topology was handled. The cheapest prevention is to list, for every node, the device that holds the node IP and what kind of device it is.

```bash
#!/usr/bin/env bash
# For each node: which device holds the node IP, is it a VLAN, does it have a master.
# Flags the layout that Cilium v1.19.6 drops (node IP directly on a VLAN sub-interface).
set -euo pipefail

kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.status.addresses[?(@.type=="InternalIP")].address}{"\n"}{end}' |
while read -r node ip; do
  # ssh -n keeps ssh from consuming the while-loop's stdin
  info=$(ssh -n -o ConnectTimeout=5 "${node}" "
    dev=\$(ip -o addr show | awk -v ip='${ip}' '\$4 ~ \"^\"ip\"/\" {print \$2; exit}')
    [ -n \"\$dev\" ] || { echo 'NOT-FOUND - -'; exit 0; }
    kind=plain
    [ -e /proc/net/vlan/\$dev ] && kind=vlan
    [ -d /sys/class/net/\$dev/bridge ] && kind=bridge
    if [ \$kind = bridge ]; then
      ports=\$(ls /sys/class/net/\$dev/brif | tr '\n' ',')
    else
      ports=-
    fi
    echo \"\$dev \$kind \$ports\"
  " 2>/dev/null || echo "UNREACHABLE - -")
  read -r dev kind ports <<< "${info}"
  label=$(kubectl get node "${node}" -o jsonpath='{.metadata.labels.network\.support\.tools/br0}')
  flag=""
  if [ "${kind}" = "vlan" ]; then
    flag="RISK: node IP on VLAN sub-interface without a bridge"
  elif [ "${kind}" = "bridge" ] && [[ "${ports}" == *.* ]] && [ "${label}" != "true" ]; then
    flag="RISK: bridge over VLAN but missing br0 label (no vlan-bpf-bypass)"
  fi
  printf '%-14s %-16s %-10s %-7s %-14s %s\n' "${node}" "${ip}" "${dev}" "${kind}" "${ports}" "${flag}"
done
```

Run it before every Cilium upgrade and treat any `RISK` line as a blocker. A node flagged for the VLAN sub-interface layout gets converted to the bridge layout, labeled, and given the `bridge-nf-call-iptables` drop-in, in that order, before the CNI upgrade starts. A bridge-over-VLAN node missing its label gets labeled and its agent restarted.

Beyond the audit, three habits limit the damage when something slips through anyway:

- **Canary the odd nodes first.** If one node's layout is unusual, roll the new agent there deliberately, with a console open, instead of letting the DaemonSet reach it at random.
- **Have `OnDelete` ready.** Keep the `HelmChartConfig` change for `updateStrategy: OnDelete` written in advance, so pausing a bad rollout takes seconds.
- **Do not bundle changes.** This upgrade shared a maintenance window with an MTU change and a switch to WireGuard pod encryption. The VLAN problem and the bpffs cleanup added about an hour that the planned work would not have needed, and diagnosing one fault while two other changes are in flight is harder than it needs to be.

## Conclusion

Neither trap is exotic. A VLAN sub-interface holding a node IP is a textbook Linux layout, and pinned BPF links are an intentional Cilium design that makes agent restarts seamless. The damage came from the combination: a layout that was quietly nonstandard for the fleet, a minor CNI version that changed how that layout was handled, and a recovery step (stopping the agent) that does not do what most operators assume it does.

- **Cilium v1.19.6 drops all host traffic when the node IP sits directly on a VLAN sub-interface** such as `bond0.100`. A per-node `vlan-bpf-bypass` did not fix it. Moving the node IP to a `br0` over the VLAN and covering it with a label-selected `CiliumNodeConfig` did.
- **Moving a node IP onto a bridge turns on bridge netfilter for that traffic.** With kube-proxy in iptables mode, that drops most off-node LoadBalancer and NodePort traffic. Set `bridge-nf-call-iptables=0` and `bridge-nf-call-ip6tables=0` in an `ExecStartPost` drop-in on the RKE2 unit, because RKE2 resets them to 1 on every start.
- **Stopping Cilium does not detach Cilium.** tcx links pinned in `/sys/fs/bpf/cilium/devices/*/links/` outlive the agent and `rke2-killall.sh`. Disable the RKE2 unit, remove the pins on every device, and delete the `clsact` qdiscs to restore host networking.
- **Pin `devices` explicitly on every node.** Wildcard defaults select admin ports and other devices that should stay plain kernel networking, and every change to the selected set is a datapath reload.
- **Audit node network layouts before every CNI upgrade,** confirm console access on every node, and keep a rollout pause ready to apply in seconds.

## References

- Cilium documentation, VLAN 802.1q support and `vlan-bpf-bypass`: https://docs.cilium.io/en/stable/configuration/vlan-802.1q/
- Cilium documentation, per-node configuration with `CiliumNodeConfig`: https://docs.cilium.io/en/stable/configuration/per-node-config/
- Cilium upgrade guide: https://docs.cilium.io/en/stable/operations/upgrade/
- `bpftool-net(8)` and `bpftool-link(8)` manual pages
- RKE2 `HelmChartConfig` and bundled chart customization: https://docs.rke2.io/helm
