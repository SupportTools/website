---
title: "Cilium BPF Compile Fails with 'macro redefined': How NetworkManager Disabled IPv6 on cilium_host"
date: 2026-10-22T09:00:00-05:00
draft: false
tags: ["Cilium", "Kubernetes", "NetworkManager", "Netplan", "eBPF", "IPv6", "Troubleshooting", "RKE2", "CNI"]
categories:
- Kubernetes
- Networking
- Troubleshooting
author: "Matthew Mattox - mmattox@support.tools"
description: "Cilium endpoint BPF compiles failing with 'MONITOR_AGGREGATION macro redefined' are a symptom. Root cause: NetworkManager disabled IPv6 on cilium_host, so node_config.h was never written."
more_link: "yes"
url: "/cilium-bpf-macro-redefined-node-config-h-networkmanager-cilium-host-ipv6/"
---

One Kubernetes node stopped giving pods a network. Every other node in the cluster was fine. New pods on the bad node sat in `ContainerCreating` until the CNI ADD call timed out, and the Cilium agent log on that node was a wall of clang errors:

```text
error: 'MONITOR_AGGREGATION' macro redefined [-Werror,-Wmacro-redefined]
error: 'ENABLE_ARP_RESPONDER' macro redefined [-Werror,-Wmacro-redefined]
```

Those lines look like a Cilium bug, a clang version mismatch, or a kernel header problem. They are none of those. The BPF compiler was doing exactly what it was told, against a header file that should have been generated a minute earlier and never was. The real failure was much further up the log: **NetworkManager** had applied a catch-all connection profile to the `cilium_host` interface and turned IPv6 off on it, which made Cilium's datapath initialization fail with `permission denied`. This post walks through how that chain works, how to confirm it in under five minutes, and the three changes that fix it permanently.

<!--more-->

## The symptom: every endpoint regeneration fails

The visible damage on the affected node:

- New pods never get an IP. The kubelet reports a CNI timeout, and the pod sits in `ContainerCreating`.
- Existing pods that were created before the problem started keep working for a while, then lose connectivity as their endpoints get regenerated and fail.
- `cilium-dbg status` on the node shows failing controllers and endpoints stuck in `not-ready` or `regenerating`.
- The agent log repeats BPF compile failures for every endpoint, every few seconds.

An abbreviated version of what the agent log showed (field values trimmed, ordering preserved):

```text
level=error msg="Regeneration of endpoint failed" subsys=endpoint endpointID=1873
  error="failed to compile template program: Failed to compile bpf_lxc.o: exit status 1"
level=warn msg="/var/run/cilium/state/templates/.../ep_config.h: error: 'MONITOR_AGGREGATION' macro redefined [-Werror,-Wmacro-redefined]"
level=warn msg="/var/run/cilium/state/templates/.../ep_config.h: error: 'ENABLE_ARP_RESPONDER' macro redefined [-Werror,-Wmacro-redefined]"
```

The natural reaction is to search for the macro name, find nothing useful, and start comparing clang and kernel versions across nodes. That path goes nowhere, because the versions match. The node that fails has the same agent image, the same kernel, and the same clang as the nodes that work.

## Why the compiler complains about macros

Cilium builds its per-endpoint BPF programs from C source at runtime. Two generated headers feed every compile:

| Header | Scope | Written when |
|---|---|---|
| `node_config.h` | Node-wide defines (addresses, enabled features, map sizes) | Once, during **datapath initialization** |
| `ep_config.h` | Per-endpoint defines | Every endpoint regeneration |

On Cilium 1.18 the node-wide header lives at `/var/run/cilium/state/globals/node_config.h`. The endpoint headers are written assuming the node-wide header already contains the real node configuration. If datapath init never completes, the agent never writes the real `node_config.h`, and the compile includes a placeholder version instead. That placeholder defines some of the same macros that the endpoint header defines, so clang sees `MONITOR_AGGREGATION` and `ENABLE_ARP_RESPONDER` defined twice and stops, because Cilium compiles with warnings promoted to errors.

So the macro errors carry one piece of information: **datapath initialization failed earlier on this node.** They do not tell you why. The actual error is the first one in the log, not the loudest one.

## Finding the first error

Pull the agent log for the affected node and search for initialization failures before the first compile error:

```bash
# Find the Cilium agent pod on the broken node
NODE=worker-07
POD=$(kubectl -n kube-system get pod -l k8s-app=cilium \
  --field-selector spec.nodeName="${NODE}" -o jsonpath='{.items[0].metadata.name}')

# The compile errors are the noise; the init error is the signal
kubectl -n kube-system logs "${POD}" -c cilium-agent \
  | grep -n -E "cilium_host|Reinitialize|datapath|node_config|macro redefined" \
  | head -40
```

In this incident the first relevant hit, abbreviated, was:

```text
level=error msg="Error while initializing daemon" subsys=daemon
  error="failed to add internal IP address to cilium_host: permission denied"
```

`permission denied` from an agent running as a privileged pod with `CAP_NET_ADMIN` is a strong hint. The kernel returns `EACCES` when something tries to add an IPv6 address to an interface that has IPv6 disabled. On a dual-stack cluster, Cilium assigns the node's internal router IPv6 address to `cilium_host` during init, so that add is one of the first things to fail.

Confirm it directly on the node:

```bash
# 1 means IPv6 is disabled on the interface, which breaks dual-stack Cilium
cat /proc/sys/net/ipv6/conf/cilium_host/disable_ipv6

# Compare with a healthy node and with the kernel default for new interfaces
cat /proc/sys/net/ipv6/conf/default/disable_ipv6
cat /proc/sys/net/ipv6/conf/all/disable_ipv6
```

On the broken node `cilium_host` returned `1`. `default` and `all` returned `0`. Something had set the flag on that one interface after it was created.

## The culprit: a netplan profile with an empty match

The node used netplan with `renderer: NetworkManager`. On recent Ubuntu releases, NetworkManager writes connection profiles back into netplan as `/etc/netplan/90-NM-<uuid>.yaml` files. One of those files looked like this (sanitized):

```yaml
network:
  version: 2
  ethernets:
    NM-3f2a9c1e-5b7d-4e8a-9c21-7d4b2e6f8a10:
      renderer: NetworkManager
      match: {}                      # matches ANY ethernet-type device
      dhcp4: true
      networkmanager:
        uuid: "3f2a9c1e-5b7d-4e8a-9c21-7d4b2e6f8a10"
        name: "Wired connection 1"
        passthrough:
          ipv6.method: "disabled"    # NetworkManager sets disable_ipv6=1 on the device
```

Two properties combine into the failure:

1. **`match: {}`** binds the profile to no particular device. NetworkManager treats it as eligible for any device of the matching type.
2. **`ipv6.method: disabled`** tells NetworkManager to write `disable_ipv6=1` for whatever device the profile activates on.

`cilium_host` and its peer `cilium_net` are a veth pair, and NetworkManager classifies veth devices as ethernet. When Cilium created `cilium_host`, NetworkManager saw a new, unmanaged ethernet device with no connection, found a profile that matched everything, activated it, and dutifully disabled IPv6 on the interface. From that point Cilium's init could not add its IPv6 address, and every later compile failed.

You can see the binding with `nmcli`:

```bash
# Look for a profile active on cilium_host or any lxc* device
nmcli -f NAME,UUID,TYPE,DEVICE connection show --active

# Healthy output lists cilium_* and lxc* devices as "unmanaged"
nmcli -f DEVICE,TYPE,STATE,CONNECTION device status | grep -E "cilium|lxc"
```

On the broken node, `cilium_host` showed `connected` with `Wired connection 1` as its connection. That is the smoking gun.

### Why only one node

The profile was a leftover. Nodes that were provisioned with a clean netplan config had only NIC-specific profiles, which can never match `cilium_host`. This node had once been brought up with a generic wired profile, and NetworkManager had persisted it into netplan. It sat there harmlessly until a reboot recreated `cilium_host` while NetworkManager was running. Configuration drift between nodes that are supposed to be identical is the common thread in most single-node CNI failures, and this is a clean example of it.

### What does not cause this

Two neighboring causes produce similar symptoms and are worth ruling out:

- **IPv4-only clusters** do not hit this path. With `enable-ipv6: false`, Cilium never adds an IPv6 address to `cilium_host`, so `disable_ipv6=1` is harmless there. The failure needs dual-stack or IPv6-only Cilium.
- **`net.ipv6.conf.default.disable_ipv6=1`** set by a sysctl drop-in causes the same init error on every new interface, but it shows up as `1` on `default`, not just on `cilium_host`. If `default` is `1`, fix the sysctl drop-in, not NetworkManager.

## Fix 1: restore IPv6 on cilium_host and restart the agent

This gets the node working again. It does not stop the problem from coming back.

```bash
# On the affected node: re-enable IPv6 on the Cilium host interface
sudo sysctl -w net.ipv6.conf.cilium_host.disable_ipv6=0

# Verify before restarting the agent
cat /proc/sys/net/ipv6/conf/cilium_host/disable_ipv6
```

Then restart the Cilium agent on that node so it re-runs datapath initialization from the start:

```bash
# Delete only the agent pod on the affected node; the DaemonSet recreates it
kubectl -n kube-system delete pod -l k8s-app=cilium \
  --field-selector spec.nodeName="${NODE}"

# Wait for the replacement to become ready
kubectl -n kube-system wait pod -l k8s-app=cilium \
  --field-selector spec.nodeName="${NODE}" --for=condition=Ready --timeout=5m
```

Do not try to persist the sysctl with a file in `/etc/sysctl.d/`. Those files are applied at boot, before Cilium creates `cilium_host`, so a per-interface key for an interface that does not exist yet does nothing. If NetworkManager is left in control of the device, it will flip the flag back on its next activation anyway. The durable fixes are the next two.

## Fix 2: pin every netplan profile to its NIC

Find every profile that can match devices it was never meant for:

```bash
# Catch-all profiles: an empty match block, or no match block on an ethernet
sudo grep -l -E "match: \{\}" /etc/netplan/*.yaml

# Show which physical NIC each catch-all profile is actually serving today
nmcli -f NAME,UUID,DEVICE connection show --active
```

For each file, replace the empty match with the name of the NIC it should own. Keep a backup next to it, and make sure the backup does not end in `.yaml`, or netplan will load it as config:

```bash
F=/etc/netplan/90-NM-3f2a9c1e-5b7d-4e8a-9c21-7d4b2e6f8a10.yaml
NIC=eno1

# Back up with a suffix netplan ignores
sudo cp -a "${F}" "${F}.pre-ciliumfix"

# Bind the profile to exactly one interface
sudo sed -i "s/match: {}/match:\n        name: ${NIC}/" "${F}"

# Netplan refuses world-readable configs; keep the original mode
sudo chmod 600 "${F}"
```

The resulting stanza:

```yaml
network:
  version: 2
  ethernets:
    NM-3f2a9c1e-5b7d-4e8a-9c21-7d4b2e6f8a10:
      renderer: NetworkManager
      match:
        name: eno1                   # only the physical NIC can activate this profile
      dhcp4: true
      networkmanager:
        uuid: "3f2a9c1e-5b7d-4e8a-9c21-7d4b2e6f8a10"
        name: "Wired connection 1"
        passthrough:
          ipv6.method: "disabled"
```

Then regenerate NetworkManager's view of the profiles without bouncing interfaces:

```bash
# Render netplan YAML into NetworkManager keyfiles under /run
sudo netplan generate

# Tell NetworkManager to re-read connection profiles from disk
sudo nmcli connection reload
```

Be careful with `netplan apply` on hosts that carry bonds, bridges, or VM traffic. With the NetworkManager renderer it can reactivate connections and briefly take down a bond or bridge, which strands KubeVirt VMs and anything else attached to it. `netplan generate` plus `nmcli connection reload` updates the profiles and leaves running links alone. The pinned match takes effect the next time the connection activates.

## Fix 3: tell NetworkManager to leave Cilium devices alone

Pinning profiles fixes the profiles that exist today. The next generic profile someone creates, or the next provisioning tool that writes one, can bring the problem back. The real guardrail is to make NetworkManager refuse to manage Cilium's devices at all.

Create `/etc/NetworkManager/conf.d/90-cilium-unmanaged.conf`:

```ini
# Cilium owns these interfaces. NetworkManager must never activate a
# connection profile on them, set sysctls on them, or touch their addresses.
[keyfile]
unmanaged-devices=interface-name:cilium_*;interface-name:lxc*
```

The two patterns cover everything Cilium creates on a node:

| Pattern | Devices |
|---|---|
| `interface-name:cilium_*` | `cilium_host`, `cilium_net`, `cilium_vxlan`, `cilium_geneve`, `cilium_wg0` |
| `interface-name:lxc*` | Per-pod endpoint veths, plus `lxc_health` |

If the node already has an `unmanaged-devices` line in another conf.d file, merge the patterns into one line. NetworkManager reads the key from the highest-priority file that sets it, so a second file does not append to the first.

Load the new configuration and confirm it took:

```bash
# Re-read NetworkManager.conf and conf.d without restarting the daemon
sudo nmcli general reload conf

# Every Cilium and endpoint device should now report "unmanaged"
nmcli -f DEVICE,TYPE,STATE device status | grep -E "cilium|lxc"
```

Expected output:

```text
cilium_host    ethernet  unmanaged
cilium_net     ethernet  unmanaged
cilium_vxlan   vxlan     unmanaged
lxc_health     ethernet  unmanaged
lxc8a1f0e6d2c  ethernet  unmanaged
```

This belongs on every NetworkManager-managed Kubernetes node that runs Cilium, not only on the node that broke. Nodes managed by systemd-networkd need the equivalent: a `.network` file that matches `cilium_* lxc*` with `Unmanaged=yes`, or simply no catch-all `[Match]` sections.

## Recreate everything created while the datapath was down

Getting the agent healthy again does not repair pods that were scheduled onto the node while the datapath was broken. They came up with incomplete or stale routing and stay broken after the agent recovers. Recreate them:

```bash
# Every non-hostNetwork pod on the node that started during the outage window
kubectl get pods -A --field-selector spec.nodeName="${NODE}" \
  -o jsonpath='{range .items[?(@.spec.hostNetwork!=true)]}{.metadata.namespace}{" "}{.metadata.name}{" "}{.status.startTime}{"\n"}{end}' \
  | sort -k3
```

Delete the ones whose start time falls inside the outage, starting with infrastructure.

Pay particular attention to storage daemons. In this incident a Longhorn instance-manager pod on the node was left in place after the agent recovered. A stateful workload's iSCSI-backed volume on that node started returning `ENXIO`, and the kubelet went as far as attempting to run `mkfs` on it during a remount. That is the kind of secondary failure that turns a networking outage into a data-loss incident. If a storage engine's data path runs through pods on the affected node, recreate those pods and confirm volume health before letting workloads remount.

```bash
# Longhorn example: recreate the instance-manager on the recovered node
kubectl -n longhorn-system delete pod -l longhorn.io/component=instance-manager \
  --field-selector spec.nodeName="${NODE}"

# Check that no volume on the node is degraded or faulted before moving on
kubectl -n longhorn-system get volumes.longhorn.io \
  -o custom-columns=NAME:.metadata.name,STATE:.status.state,ROBUSTNESS:.status.robustness,NODE:.status.currentNodeID \
  | grep -E "NAME|${NODE}"
```

## Verification

The fix is complete when all of the following hold on the affected node:

```bash
# 1. The real node-wide header exists and is recent
sudo ls -l /var/run/cilium/state/globals/node_config.h

# 2. No compile errors since the agent restarted
kubectl -n kube-system logs "${POD}" -c cilium-agent --since=10m | grep -c "macro redefined"

# 3. Controllers and endpoints are healthy
kubectl -n kube-system exec "${POD}" -c cilium-agent -- cilium-dbg status --verbose \
  | grep -E "Controller Status|Cluster health|IPv6"

# 4. The fix survives NetworkManager restarting and re-evaluating devices
sudo systemctl restart NetworkManager
cat /proc/sys/net/ipv6/conf/cilium_host/disable_ipv6   # must still print 0
```

Step 4 is the one that matters most. A node where `disable_ipv6` goes back to `1` after a NetworkManager restart is a node that will fail again on its next reboot.

Finish with a real traffic check: schedule a test pod pinned to the node and resolve a name through cluster DNS, which forces traffic from the new endpoint to CoreDNS pods that are usually on other nodes.

```bash
kubectl run nettest --rm -it --restart=Never --image=busybox:1.36 \
  --overrides="{\"spec\":{\"nodeName\":\"${NODE}\"}}" -- \
  sh -c 'nslookup -type=A kubernetes.default && nslookup -type=AAAA kubernetes.default'
```

## Rolling the guardrail out fleet-wide

A fix applied by hand on one node is the drift that caused this incident in the first place. Push both changes through configuration management so every node converges. A minimal Ansible version:

```yaml
- name: Keep NetworkManager away from Cilium devices
  hosts: k8s_nodes
  become: true
  tasks:
    - name: Install the unmanaged-devices drop-in
      ansible.builtin.copy:
        dest: /etc/NetworkManager/conf.d/90-cilium-unmanaged.conf
        owner: root
        group: root
        mode: "0644"
        content: |
          # Managed by Ansible. Cilium owns these interfaces.
          [keyfile]
          unmanaged-devices=interface-name:cilium_*;interface-name:lxc*
      notify: Reload NetworkManager conf

    - name: Find catch-all netplan profiles
      ansible.builtin.command: 'grep -rlE "match: \{\}" --include=*.yaml /etc/netplan/'
      register: catchall
      changed_when: false
      failed_when: catchall.rc > 1

    - name: Fail loudly so a human pins each catch-all profile to its NIC
      ansible.builtin.fail:
        msg: "Catch-all netplan profiles need a NIC-specific match: {{ catchall.stdout_lines }}"
      when: catchall.stdout_lines | length > 0

  handlers:
    - name: Reload NetworkManager conf
      ansible.builtin.command: nmcli general reload conf
```

The playbook deliberately fails on catch-all profiles instead of rewriting them. Which NIC a profile should own is a per-host decision, and getting it wrong on a bonded host takes the node off the network. Make the automation detect the problem and let a person choose the interface.

## Alerting on the failure mode

The agent exposes enough metrics to catch this within minutes, well before users notice pods stuck in `ContainerCreating`:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: cilium-datapath-health
  namespace: monitoring
spec:
  groups:
    - name: cilium-datapath
      rules:
        - alert: CiliumEndpointRegenerationFailing
          # Sustained regeneration failures on one node: compile errors, missing node_config.h
          expr: sum by (pod) (rate(cilium_endpoint_regenerations_total{outcome="fail"}[10m])) > 0
          for: 15m
          labels:
            severity: critical
          annotations:
            summary: "Cilium endpoint regenerations failing on {{ $labels.pod }}"
            description: "Check the agent log for the FIRST init error, not the BPF compile errors."
        - alert: CiliumControllersFailing
          # Init failures leave controllers in a failing state
          expr: max by (pod) (cilium_controllers_failing) > 0
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "Cilium agent {{ $labels.pod }} has failing controllers"
```

Pair the alert with a runbook line that says, in bold, to read the first error in the agent log. The whole cost of this class of incident is time spent on the loud error instead of the first one.

## Key takeaways

- **`macro redefined` errors in Cilium BPF compiles are a symptom.** They mean `node_config.h` was never generated because datapath initialization failed earlier. Do not chase clang or kernel versions.
- **Read the first error in the agent log.** Here it was `failed to add internal IP address to cilium_host: permission denied`, which is the kernel refusing an IPv6 address on an interface with IPv6 disabled.
- **Check `/proc/sys/net/ipv6/conf/cilium_host/disable_ipv6`.** On a dual-stack cluster it must be `0`. If only `cilium_host` shows `1`, something on the node set it after the interface was created.
- **A netplan profile with `match: {}` matches every ethernet device, including Cilium's veths.** Combined with `ipv6.method: disabled`, NetworkManager will disable IPv6 on `cilium_host` the moment it appears.
- **Fix it in three layers:** `sysctl -w net.ipv6.conf.cilium_host.disable_ipv6=0` plus an agent restart to recover, a NIC-specific `match` on every `90-NM-*.yaml` profile, and `/etc/NetworkManager/conf.d/90-cilium-unmanaged.conf` with `unmanaged-devices=interface-name:cilium_*;interface-name:lxc*` on every node.
- **Prefer `netplan generate` and `nmcli connection reload` over `netplan apply`** on hosts with bonds, bridges, or VM traffic.
- **Recreate pods created during the outage,** storage daemons first, and confirm volume health before workloads remount.

## References

- NetworkManager.conf(5): `unmanaged-devices` and device specification syntax
- netplan YAML reference: `match`, `renderer`, and the `networkmanager.passthrough` mapping
- Cilium documentation: System Requirements, notes on network managers and Cilium-owned interfaces
- Linux kernel `ip-sysctl` documentation: `net.ipv6.conf.<interface>.disable_ipv6`
