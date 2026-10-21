---
title: "Cilium MTU Black Hole: How a Linux Bridge and KubeVirt VMs Silently Broke VXLAN and Kept Longhorn Degraded"
date: 2026-10-25T09:00:00-05:00
draft: false
tags: ["Cilium", "MTU", "VXLAN", "KubeVirt", "Longhorn", "RKE2", "Kubernetes"]
categories:
- Networking
- Kubernetes
- Troubleshooting
author: "Matthew Mattox - mmattox@support.tools"
description: "Cilium with no MTU set followed a Linux bridge's MTU live. KubeVirt VM veths dragged it from 9000 to 1500, VXLAN silently dropped large packets, and Longhorn stayed degraded. Detection, fix, and the outage."
more_link: "yes"
url: "/cilium-mtu-linux-bridge-kubevirt-vxlan-blackhole-longhorn-degraded/"
images: ["https://cdn.support.tools/posts/cilium-mtu-linux-bridge-kubevirt-vxlan-blackhole-longhorn-degraded/og-27e9d8bc08.jpg"]
---

For about ten hours, roughly 45 Longhorn volumes on one of our production RKE2 clusters sat in a degraded state. Replicas flapped to `ERR`, rebuilds started and failed, and the Longhorn event stream logged more than 1,400 replica errors, nearly 800 of them in a single hour on one node. Small API calls worked. DNS worked. Health checks were green. Only bulk traffic between certain pairs of nodes was disappearing, and which pairs changed over the course of the day.

The cause turned out to be three ordinary behaviors stacked on top of each other. A Linux bridge takes the MTU of its smallest port. KubeVirt VMs attach 1500-byte veths to that bridge. And Cilium, with no MTU configured, does not just read the device MTU at startup: it follows it while running. Pods keep the MTU they were created with. So every time a VM moved onto or off a node, that node's tunnel MTU changed underneath pods that still believed the old value, and their large VXLAN packets went into a black hole with no error anywhere.

This post walks through the mechanism, a reproducible demonstration of the bridge behavior, the commands that prove it on a live cluster, the fix (pin the MTU, flatten the underlay), and the planned full-cluster outage it took to apply that fix safely.

<!--more-->

## The symptom: storage that would not stay healthy

The trigger was routine maintenance. A rolling OS patch run was draining nodes one at a time, live-migrating KubeVirt VMs off each node before reboot and letting them settle wherever the scheduler put them. Partway through, Longhorn started reporting degraded volumes, and the count kept climbing instead of recovering after each node came back.

What we saw:

- Longhorn replicas marked `ERR` with engine-to-replica timeouts. Longhorn's `engine-replica-timeout` setting defaults to 8 seconds, and replica I/O was stalling past it.
- Rebuilds that started, ran for a while, and failed, leaving the volume degraded again.
- The failures concentrated on specific nodes, and the set of affected nodes shifted as VMs migrated around.
- Nothing obvious in the network: no interface errors on the hosts we checked first, no Cilium agent errors, no dropped-packet alerts, every node `Ready`.

That combination (bulk transfers failing, small requests fine, behavior that moves around) is the fingerprint of an MTU problem. It still took most of a day to tie it to MTU, because the MTU configuration everywhere looked correct. It was correct when it was set. It just did not stay that way.

## The environment

The relevant parts of the cluster:

| Component | Configuration |
|---|---|
| Kubernetes | RKE2, roughly a dozen bare-metal nodes, mixed hardware |
| CNI | Cilium in VXLAN tunnel mode, deployed through RKE2's `rke2-cilium` chart |
| Cilium MTU | **Not set**, so the agent auto-detects it from its devices |
| Node networking | Node IP on a Linux bridge `br0`, on top of an LACP bond, MTU 9000 (jumbo frames) on most nodes |
| VMs | KubeVirt, with VMs on a Multus bridge network attached to the same host `br0` |
| Storage | Longhorn, three replicas per volume, replica traffic over the pod network |

The 9000-byte underlay was recent. A few weeks earlier we had chased a different MTU problem: a CI runner doing Docker-in-Docker builds timed out fetching packages whenever it landed on a node with a 1500-byte underlay. Pods on the 9000-byte nodes were sending VXLAN frames that the 1500-byte node's NIC dropped as oversized (they showed up as `rx_long_length_errors` and nothing else), and the nested Docker network advertised a TCP MSS large enough to trigger it. The decision at the time was to fix the mismatch by raising every node that could support it to 9000, rather than pinning a lower MTU in Cilium.

That decision is the background to everything below. It assumed a node's MTU is a static property you set once in netplan. On a node whose uplink is a bridge shared with VMs, it is not.

## Mechanism part 1: a Linux bridge takes the MTU of its smallest port

By default, the kernel keeps a bridge's MTU equal to the minimum MTU across its ports, and it recomputes that whenever a port joins or leaves. Add a port with a smaller MTU and the bridge drops to match. Remove it and the bridge climbs back up.

You do not need a lab to see this. The following script runs entirely inside a throwaway, unprivileged network namespace (`unshare -rn`), so it touches nothing on the host:

```bash
#!/usr/bin/env bash
# bridge-mtu-demo.sh: show a Linux bridge following its smallest port's MTU.
# Runs in a private user + network namespace; nothing on the host changes.
unshare -rn bash -c '
m() { ip -o link show br0 | grep -o "mtu [0-9]*"; }

ip link add br0 type bridge
ip link add d0 type dummy
ip link set d0 mtu 9000 master br0
echo "one 9000 port:             $(m)"

ip link add v0 type veth peer name v1      # veths are created at 1500
ip link set v0 master br0
echo "plus one 1500 veth:        $(m)"

ip link del v0
echo "veth removed:              $(m)"

ip link set br0 mtu 9000                   # set it explicitly this time
ip link add v2 type veth peer name v3
ip link set v2 master br0
echo "explicit 9000, plus veth:  $(m)"

ip link del v2
echo "veth removed again:        $(m)"
'
```

Output on a 7.0 kernel:

```text
one 9000 port:             mtu 9000
plus one 1500 veth:        mtu 1500
veth removed:              mtu 9000
explicit 9000, plus veth:  mtu 1500
veth removed again:        mtu 9000
```

The last two lines matter most. Even after the bridge MTU was set explicitly, attaching a single 1500-byte port pulled it down again. Bridge MTU auto-tuning has changed across kernel versions (the logic lives in `br_mtu_auto_adjust()` in `net/bridge/br_if.c`), so run the script on your own kernel rather than trusting a blog post, including this one. The safe assumption is that a bridge's MTU is a function of whatever happens to be plugged into it right now.

One trap if you adapt the script: read the MTU with `ip link`, not `/sys/class/net/br0/mtu`. Inside `unshare -rn`, `/sys` is still the host's sysfs mount, so you will read the host's interfaces and get confusing answers.

Now apply that to a KubeVirt node. A VM on a Multus bridge network gets a veth whose host end is attached to `br0`. Unless the NetworkAttachmentDefinition sets an `mtu`, that veth is created at 1500. The moment the first such VM lands on a node, the node's `br0` falls from 9000 to 1500. When the last one migrates away, it goes back to 9000. A rolling patch run that live-migrates VMs between nodes flips several nodes back and forth over a few hours.

## Mechanism part 2: Cilium follows the device MTU while it runs

With no `MTU` value in its configuration, Cilium derives its MTU from the devices it manages, and it keeps watching them. When `br0` changed, the Cilium agent on that node followed: `cilium_vxlan` and the routes it installs for new pods moved to the new value.

Existing pods did not move. A pod's interface MTU and route MTU are set when the pod's endpoint is created, and nothing goes back and rewrites them. That leaves a node in a state that the configuration never describes:

| Time | `br0` | `cilium_vxlan` | Pods created before | Pods created after |
|---|---|---|---|---|
| Node boots, no VMs | 9000 | 9000 | n/a | 9000 interface, 8950 route MTU |
| A VM migrates in | 1500 | 1500 | **still 9000 / 8950** | 1500 interface, 1450 route MTU |
| The VM migrates out | 9000 | 9000 | mix of both | 9000 / 8950 |

The 50-byte difference between interface and route MTU is the VXLAN encapsulation overhead that Cilium subtracts. The middle row is the broken state. On the worst node we measured **175 pod veths at MTU 9000 sitting behind a `cilium_vxlan` at 1500**.

## Why the drops were silent

Normally a packet that is too big for the next hop with Don't Fragment set produces an ICMP "fragmentation needed" message, the sender lowers its path MTU, and TCP carries on. Path MTU discovery is the whole reason a mismatch is usually a slowdown instead of an outage.

That recovery never happened here. Cilium forwards pod traffic in eBPF and encapsulates it into VXLAN, so the oversized inner packet never takes the normal kernel routing path that would generate an ICMP error back to the pod. Oversized frames were dropped, either before they left the sending node or at the receiving NIC, and the sending pod never learned why. TCP retransmitted the same oversized segment until the connection or the application gave up.

It also explains why most things kept working:

- **Small packets always fit.** DNS, health probes, Kubernetes API calls and most HTTP request/response traffic are well under 1400 bytes.
- **MSS negotiation hides the problem for some pairs.** TCP picks the smaller of the two endpoints' advertised MSS values. If either pod was created after the drop to 1500, the connection used a small MSS and worked fine. Only connections where both ends were "old" 8950-byte pods, crossing a node whose tunnel had dropped to 1500, built segments too big to deliver.
- **It moved.** Each VM migration changed which nodes were broken and which pods were old, so any single test told you about the current moment and nothing more.

## Why Longhorn felt it first

Longhorn replica traffic is close to a worst case for this failure. An engine streams large writes to two or three replicas on other nodes, over long-lived TCP connections between pods that were created long ago (instance managers are rarely restarted). Those connections had negotiated large MSS values back when every node was at 9000.

When a node's tunnel dropped to 1500, writes to replicas on that node stalled. After 8 seconds the engine declared the replica failed and marked it `ERR`. Longhorn then started a rebuild, which uses the same path and the same large segments, so the rebuild stalled too. Meanwhile the patch run kept migrating VMs, breaking new node pairs before the old ones recovered. Hence a degraded-volume count that ratcheted upward for hours instead of healing.

Repeated replica failures had a second cost. A few volumes ended up with replicas that had genuinely diverged, and recovering those meant restoring from backup rather than waiting for a rebuild. Silent packet loss on a storage network is never just a performance problem.

## Proving it on a live cluster

Do not schedule an outage on a hunch. These are the checks that turned the theory into a measurement before we touched anything.

### Check 1: compare tunnel MTU with pod veth MTUs on every node

Run this on each node (over SSH, or from a node debug pod, which shares the host network namespace):

```bash
#!/usr/bin/env bash
# mtu-audit.sh: print the MTUs that matter for Cilium VXLAN on this node.
set -euo pipefail

mtu_of() { ip -o link show "$@" | awk '{for (i = 1; i <= NF; i++) if ($i == "mtu") print $(i + 1)}'; }

echo "node: $(hostname)"
for dev in br0 cilium_vxlan cilium_host; do
  if ip link show "$dev" >/dev/null 2>&1; then
    printf '  %-13s mtu %s\n' "$dev" "$(mtu_of dev "$dev")"
  fi
done

echo "  pod veths (lxc*) by MTU:"
ip -o link show | awk '$2 ~ /^lxc/' | awk '{for (i = 1; i <= NF; i++) if ($i == "mtu") print $(i + 1)}' \
  | sort | uniq -c | sed 's/^/   /'

if ip link show br0 >/dev/null 2>&1; then
  echo "  br0 ports by MTU:"
  mtu_of master br0 | sort | uniq -c | sed 's/^/   /'
fi
```

For one-off checks without SSH access, a node debug pod works because it runs in the host network namespace:

```bash
kubectl debug node/worker-3 -it --image=nicolaka/netshoot
# then, inside the debug pod:
ip -o link show cilium_vxlan; ip -o link show master br0
```

Remember to delete the `node-debugger-*` pod afterwards.

The worst node looked like this (reconstructed from our measurements, with a generic node name):

```text
node: worker-3
  br0           mtu 1500
  cilium_vxlan  mtu 1500
  cilium_host   mtu 1500
  pod veths (lxc*) by MTU:
      175 9000
       12 1500
  br0 ports by MTU:
        1 9000
        2 1500
```

That output is the whole incident in eight lines. The bridge has two 1500-byte ports (VM veths) dragging it down from the bond's 9000, the tunnel followed it, and 175 pods are still configured for a 9000-byte world. A healthy node shows a single MTU in every section.

### Check 2: confirm what Cilium thinks it was told

```bash
kubectl -n kube-system get configmap cilium-config -o jsonpath='{.data.mtu}{"\n"}'
```

Empty output or `0` means auto-detection. That is the precondition for this whole failure. After the fix, the key reads `"1500"` (verified on Cilium v1.19.6).

While you are in that ConfigMap, look at `packetization-layer-pmtud-mode`. Set to `blackhole`, it has pod TCP stacks probe down to smaller segments after repeated loss of large ones, which softens an MTU black hole but does not fix a mismatched MTU.

### Check 3: send Don't Fragment pings across nodes at specific sizes

Pod MTU problems are about specific sizes, so test specific sizes. Schedule a pair of test pods on the nodes you suspect:

```bash
kubectl run mtu-a --image=nicolaka/netshoot --restart=Never \
  --overrides='{"apiVersion":"v1","spec":{"nodeName":"worker-3"}}' -- sleep 3600
kubectl run mtu-b --image=nicolaka/netshoot --restart=Never \
  --overrides='{"apiVersion":"v1","spec":{"nodeName":"worker-5"}}' -- sleep 3600
kubectl wait --for=condition=Ready pod/mtu-a pod/mtu-b --timeout=120s

B_IP=$(kubectl get pod mtu-b -o jsonpath='{.status.podIP}')
for size in 1372 1422 1472 4000 8922; do
  if kubectl exec mtu-a -- ping -M do -c 3 -W 2 -s "$size" "$B_IP" >/dev/null 2>&1; then
    echo "$size bytes: ok"
  else
    echo "$size bytes: FAIL"
  fi
done
```

The payload size plus 28 bytes of IP and ICMP headers is the packet size, so 1422 tests a 1450-byte packet and 8922 tests an 8950-byte one. Two failure modes look different, and the difference is diagnostic:

- **Fails immediately with "message too long"**: the sending pod knows its own route MTU is smaller. That is correct, healthy behavior.
- **Sends, then times out with 100% loss**: the pod believes the packet fits and something downstream drops it. That is the black hole.

In our case DF pings above about 1400 bytes vanished between affected nodes, while the same sizes between two nodes still at 9000 succeeded. Freshly created test pods may not reproduce the failure on a node that has already dropped to 1500, because they get the new, smaller MTU. Testing from the old pods themselves (or from a pod you created before the VM migration) is what shows the black hole.

Also check the underlay directly between node IPs (`ping -M do -s 8972 <node-ip>` from a host shell). If jumbo frames pass node-to-node while pod traffic fails, the problem is in the overlay MTU, not the switches.

## The fix: pin the MTU and stop depending on bridge membership

There are two ways out of this. You can try to keep every bridge port at 9000 forever (set `mtu` in every NetworkAttachmentDefinition, audit every VM, hope nothing else ever attaches a veth), or you can stop letting the CNI auto-detect a value that is not actually stable. We did the second, and flattened the underlay at the same time.

### Pin Cilium's MTU in the RKE2 HelmChartConfig

On RKE2, Cilium values go in a `HelmChartConfig` for the bundled `rke2-cilium` chart:

```yaml
# /var/lib/rancher/rke2/server/manifests/rke2-cilium-config.yaml
# (or apply it with kubectl; either way it is a cluster-scoped decision)
apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata:
  name: rke2-cilium
  namespace: kube-system
spec:
  # A failed chart upgrade should stop and wait for a human, not
  # uninstall and reinstall the CNI (the klipper-helm default).
  failurePolicy: abort
  valuesContent: |-
    # Pin the device MTU. Cilium subtracts tunnel (and encryption) overhead
    # from this to compute pod route MTUs, and stops following br0.
    MTU: 1500
```

Two warnings before you apply it:

1. **`valuesContent` replaces, it does not merge.** If your cluster already has a `rke2-cilium` HelmChartConfig, add `MTU: 1500` to the existing values. Applying the snippet above on its own would silently drop every other customization (IPv6, BGP, devices, image pins).
2. **Changing the MTU does nothing for existing pods.** Only pods created after the agent restarts get the new value. That is the reason the rest of this post exists.

### Why 1500 and not 9000

Pinning to 9000 would have been tempting, since most of the hardware supports it. We chose 1500 for three reasons:

- Some nodes in the cluster physically cannot do jumbo frames (small ARM nodes whose NICs top out at 1500) or reach the rest of the cluster over routed links that are 1500 end to end. A cluster-wide overlay MTU has to fit the smallest path.
- A bridge shared with VMs cannot be relied on to stay at 9000, as shown above. Pinning Cilium to 9000 on a node whose `br0` dropped to 1500 would just move the black hole from the pod to the host.
- For this cluster's workloads, the throughput gain from jumbo frames on the overlay was not worth a class of failure that is invisible until storage degrades.

The rule we took away: **pin the CNI MTU to the smallest MTU that any device on any path can ever have.** For most clusters with VMs on shared bridges, that number is 1500.

### Set the underlay to match

With Cilium pinned at 1500, a 9000-byte underlay buys nothing except one more thing that can disagree. We set the host networking back to 1500 everywhere so no node's behavior depends on what is attached to its bridge. In netplan:

```yaml
# /etc/netplan/50-cloud-init.yaml (excerpt)
network:
  version: 2
  ethernets:
    eno1: {mtu: 1500}
    eno2: {mtu: 1500}
  bonds:
    bond0:
      interfaces: [eno1, eno2]
      mtu: 1500
      parameters:
        mode: 802.3ad
  bridges:
    br0:
      interfaces: [bond0]
      mtu: 1500
```

On nodes that host VMs on `br0`, avoid `netplan apply`. With the NetworkManager renderer it can re-activate the bond and bridge and strand running VMs. Run `netplan generate` to render the configuration and let the reboot during the outage pick it up.

## Applying it: a planned full-cluster outage

Since every pod has to be recreated to pick up a new MTU, there is no clever rolling path. A rolling restart of the Cilium agents followed by a rolling restart of every workload would spend hours in exactly the mixed-MTU state that caused the incident, with stateful workloads migrating through it. We asked for, and got, approval for a full outage: scale everything to zero, apply the change, reboot every node, bring everything back. It took about three and a half hours.

### Step 0: stop anything that will fight you

Scale the GitOps controller (ArgoCD, Flux, Fleet) to zero first. Otherwise its self-heal will scale your workloads straight back up while you are trying to drain them. Record its replica count like everything else.

### Step 1: record state, then scale down

The record is the restore plan. Write it before changing anything:

```bash
#!/usr/bin/env bash
# outage-scale-down.sh: record, then zero, everything that writes to storage.
set -euo pipefail

STATE=${STATE:-./outage-state}
# Namespaces that must stay up so the cluster can come back: CNI, storage, DNS, etc.
EXCLUDE=${EXCLUDE:-'^(kube-system|kube-node-lease|kube-public|longhorn-system|cnpg-system|kubevirt|cdi|cert-manager|cattle-.*)$'}
mkdir -p "$STATE"

# 1. Record. These files are the restore plan, so write them before touching anything.
kubectl get deploy,statefulset -A -o json | jq -r --arg ex "$EXCLUDE" '
  .items[]
  | select(.metadata.namespace | test($ex) | not)
  | select(.spec.replicas > 0)
  | [(.kind | ascii_downcase), .metadata.namespace, .metadata.name, .spec.replicas] | @tsv' \
  > "$STATE/replicas.tsv"

kubectl get cronjob -A -o json | jq -r --arg ex "$EXCLUDE" '
  .items[]
  | select(.metadata.namespace | test($ex) | not)
  | select(.spec.suspend != true)
  | [.metadata.namespace, .metadata.name] | @tsv' \
  > "$STATE/cronjobs.tsv"

kubectl get clusters.postgresql.cnpg.io -A -o json | jq -r '
  .items[] | [.metadata.namespace, .metadata.name] | @tsv' \
  > "$STATE/cnpg.tsv"

kubectl get virtualmachines.kubevirt.io -A -o json | jq -r '
  .items[] | select(.status.printableStatus == "Running")
  | [.metadata.namespace, .metadata.name] | @tsv' \
  > "$STATE/vms.tsv"

wc -l "$STATE"/*.tsv

# 2. Act, in dependency order.
while IFS=$'\t' read -r ns name; do
  kubectl -n "$ns" patch cronjob "$name" --type merge -p '{"spec":{"suspend":true}}' </dev/null
done < "$STATE/cronjobs.tsv"

while IFS=$'\t' read -r ns name; do
  kubectl -n "$ns" annotate clusters.postgresql.cnpg.io "$name" cnpg.io/hibernation=on --overwrite </dev/null
done < "$STATE/cnpg.tsv"

while IFS=$'\t' read -r ns name; do
  virtctl -n "$ns" stop "$name" </dev/null
done < "$STATE/vms.tsv"

while IFS=$'\t' read -r kind ns name replicas; do
  kubectl -n "$ns" scale "$kind/$name" --replicas=0 </dev/null
done < "$STATE/replicas.tsv"
```

A few details that are easy to get wrong:

- **Use fully qualified resource names** (`clusters.postgresql.cnpg.io`, `virtualmachines.kubevirt.io`). Short names like `cluster` can resolve to a different CRD if another operator also registers one.
- **Hibernate databases rather than scaling their pods.** CloudNativePG hibernation shuts PostgreSQL down cleanly and keeps the PVCs. A cluster stuck mid-failover may refuse to hibernate; fencing all of its instances (`cnpg.io/fencedInstances: '["*"]'`) is the fallback that still gets a clean shutdown.
- **Check for guards that block VM shutdown.** If you run admission policies or PodDisruptionBudgets that protect VMs during maintenance, they will also protect them from you, and the automation that normally clears them may already be suspended.
- **Have a kubeconfig that does not depend on anything you are shutting down.** If your normal kubeconfig goes through Rancher and Rancher runs on the cluster (or in VMs on it), keep a control-plane node's `/etc/rancher/rke2/rke2.yaml` handy before you start.

### Step 2: apply the MTU change

With workloads down, apply the HelmChartConfig and confirm the rendered config before rebooting anything:

```bash
kubectl apply -f rke2-cilium-config.yaml
# The helm-install job for rke2-cilium reruns; wait for it, then:
kubectl -n kube-system get configmap cilium-config -o jsonpath='{.data.mtu}{"\n"}'
# 1500
```

Then update the underlay configuration on each node (`netplan generate`, no apply) so the reboot brings up the new MTU and the new Cilium agent at the same time.

### Step 3: reboot workers, then control plane one node at a time

With nothing running, worker nodes can reboot in parallel. Control-plane nodes cannot: etcd (and anything else with a Raft quorum, Vault included) tolerates one member down out of three. Reboot one, wait until it is truly healthy, then do the next.

"Truly healthy" needs care. A node can report `Ready` for a minute or two after it goes down, because the condition is stale until the node lease times out. Compare the boot ID instead:

```bash
reboot_and_wait() {
  local node=$1 old new
  old=$(kubectl get node "$node" -o jsonpath='{.status.nodeInfo.bootID}')
  ssh "$node" sudo systemctl reboot || true
  # Wait for a *new* boot, not a stale Ready from the old one.
  until new=$(kubectl get node "$node" -o jsonpath='{.status.nodeInfo.bootID}' 2>/dev/null) \
        && [ -n "$new" ] && [ "$new" != "$old" ]; do
    sleep 10
  done
  kubectl wait --for=condition=Ready "node/$node" --timeout=30m
}

reboot_and_wait cp-1
kubectl -n kube-system exec etcd-cp-1 -- etcdctl \
  --cacert=/var/lib/rancher/rke2/server/tls/etcd/server-ca.crt \
  --cert=/var/lib/rancher/rke2/server/tls/etcd/server-client.crt \
  --key=/var/lib/rancher/rke2/server/tls/etcd/server-client.key \
  endpoint health --cluster
# Only move on to cp-2 when every member reports healthy.
```

Etcd stayed at three healthy members through every control-plane reboot. The reboots themselves were not the slow part. One control-plane node had a failing boot disk and took 26 minutes to come back instead of 12; another had a NetworkManager profile that disabled IPv6 on `cilium_host`, which broke Cilium's datapath initialization on that node until we fixed it. A full reboot of every node is also a full test of every node's boot path, and it will find whatever has been quietly wrong since the last time.

### Step 4: verify before restoring anything

Before scaling workloads back up, prove the fix took on every node. Run `mtu-audit.sh` everywhere and expect exactly one value in every section:

```text
node: worker-3
  br0           mtu 1500
  cilium_vxlan  mtu 1500
  cilium_host   mtu 1500
  pod veths (lxc*) by MTU:
       14 1500
  br0 ports by MTU:
        3 1500
```

Then rerun the DF ping matrix between test pods on different nodes. With a 1500-byte device MTU and VXLAN, the pod route MTU is 1450 (lower again if you enable WireGuard or IPsec, which Cilium also subtracts), so the expected result is: payloads up to 1422 bytes pass, and anything larger **fails immediately with "message too long"** rather than timing out. A clean local refusal is exactly what you want to see; it means the pod knows the real limit.

Finally, test the trigger itself: live-migrate a VM onto a node and confirm `cilium_vxlan` does not change.

### Step 5: restore from the recorded state

```bash
#!/usr/bin/env bash
# outage-restore.sh: undo outage-scale-down.sh from its recorded state.
set -euo pipefail
STATE=${STATE:-./outage-state}

while IFS=$'\t' read -r ns name; do
  kubectl -n "$ns" annotate clusters.postgresql.cnpg.io "$name" cnpg.io/hibernation- </dev/null
done < "$STATE/cnpg.tsv"

while IFS=$'\t' read -r ns name; do
  virtctl -n "$ns" start "$name" </dev/null
done < "$STATE/vms.tsv"

while IFS=$'\t' read -r kind ns name replicas; do
  kubectl -n "$ns" scale "$kind/$name" --replicas="$replicas" </dev/null
done < "$STATE/replicas.tsv"

while IFS=$'\t' read -r ns name; do
  kubectl -n "$ns" patch cronjob "$name" --type merge -p '{"spec":{"suspend":false}}' </dev/null
done < "$STATE/cronjobs.tsv"
```

Restore the GitOps controller last, and audit afterwards: compare live replica counts, CNPG hibernation annotations and CronJob `suspend` flags against the recorded files. Anything that does not match is either something the restore missed or something that changed during the window, and you want to know which.

Once storage traffic was flowing at a consistent MTU, Longhorn replica `ERR` events stopped. Replicas that had exhausted Longhorn's rebuild retry limit during the incident did not retry on their own and needed manual attention afterwards, so check for those rather than assuming the degraded count will drain to zero by itself.

## Alerting so this cannot hide for ten hours again

The MTU was wrong for ten hours before anyone looked at it, because nothing measured it. node-exporter already exposes interface MTUs as `node_network_mtu_bytes`, so the alert is cheap:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: cni-mtu
  namespace: monitoring
spec:
  groups:
    - name: cni-mtu
      rules:
        - alert: CiliumTunnelMTUMismatchAcrossNodes
          expr: |
            max(node_network_mtu_bytes{device="cilium_vxlan"})
              != min(node_network_mtu_bytes{device="cilium_vxlan"})
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "cilium_vxlan MTU differs between nodes"
            description: "Pods on different nodes disagree about the overlay MTU. Large cross-node packets are likely being dropped silently."
        - alert: CiliumTunnelMTUNotPinnedValue
          expr: node_network_mtu_bytes{device="cilium_vxlan"} != 1500
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "cilium_vxlan on {{ $labels.instance }} is not at the pinned MTU"
        - alert: NodeBridgeOrTunnelMTUChanged
          expr: changes(node_network_mtu_bytes{device=~"br0|cilium_vxlan"}[30m]) > 0
          labels:
            severity: warning
          annotations:
            summary: "{{ $labels.device }} MTU changed on {{ $labels.instance }}"
            description: "A bridge or tunnel MTU changed at runtime. Existing pods keep their old MTU."
        - alert: LonghornManyVolumesDegraded
          # Longhorn 1.12 exports robustness one-hot: four series per volume
          # (state=degraded/faulted/healthy/unknown), value 1 on the current state.
          expr: count(longhorn_volume_robustness{state="degraded"} == 1) > 3
          for: 10m
          labels:
            severity: critical
          annotations:
            summary: "{{ $value }} Longhorn volumes degraded"
```

`NodeBridgeOrTunnelMTUChanged` is the one that would have caught this at the first VM migration. A bridge or tunnel MTU changing at runtime is never routine on a node running pods.

As of Longhorn 1.12, `longhorn_volume_robustness` is one-hot: every volume exports four series, one per `state`, and only the current state has the value 1. A rule written for a numeric encoding such as `== 2` never matches and never errors, so check the encoding your exporter actually produces before you rely on the alert.

## Lessons learned

**An auto-detected CNI MTU is a runtime value, not a configuration value.** If you do not set it, it is whatever the device says right now, and on a node whose uplink is a bridge, "right now" depends on which VMs are running there. Checking it at install time, or after an agent restart, tells you nothing about an hour later.

**Bridges shared with VMs are dynamic infrastructure.** Every VM migration is a network topology change on two nodes. Anything that derives configuration from the bridge (MTU, but also device selection and addressing) inherits that churn.

**Size-dependent, location-dependent failures are MTU until proven otherwise.** When bulk transfers fail and small requests succeed, and the affected nodes move, go straight to DF pings at specific sizes and compare MTUs on both ends. It would have saved most of those ten hours.

**Revisit decisions when their assumptions change.** Pinning Cilium's MTU had been considered and rejected a few weeks earlier in favor of "jumbo frames everywhere". That was a reasonable call for static hosts. It stopped being reasonable the moment those hosts' uplinks were bridges with VMs on them, and nothing prompted anyone to reconsider it.

**One change per outage window.** Since the cluster was already down, we also upgraded Cilium to a new minor release and turned on WireGuard pod encryption in the same window. Both worked in the end, but the upgrade exposed a datapath problem on two nodes with an unusual network layout and cost about an hour that the MTU fix alone would not have needed. Bundling changes into an outage feels efficient and makes every problem harder to attribute.

**A full reboot is a full audit.** A failing disk, a stray NetworkManager profile and a non-standard interface layout all surfaced only because every node rebooted at once. Better to find those in a planned window than one at a time during an unplanned one.

**Know your restore points before you need them.** Diverged replicas meant two non-production databases were restored from backup, losing several hours of writes, and one Kafka volume was recreated empty. Restore drills that measure the real recovery point are cheaper than discovering it mid-incident.

## Bottom line

If your Kubernetes nodes put their node IP on a Linux bridge that VMs also use, and your CNI has no explicit MTU, your overlay MTU changes every time a VM moves. Pods do not follow, and the mismatch drops large packets without any error.

The fix order that worked:

1. Prove it: compare `cilium_vxlan` MTU with pod veth MTUs on every node, and DF-ping across nodes at specific sizes.
2. Pin `MTU` in the Cilium values (on RKE2, the `rke2-cilium` HelmChartConfig) to the smallest MTU any path can have.
3. Set the underlay to the same value so nothing depends on bridge membership.
4. Recreate every pod. In practice that means a planned outage: record state, scale down, reboot, verify, restore.
5. Alert on MTU changes and cross-node mismatches so the next one is a page, not a ten-hour mystery.

For a refresher on finding the right MTU for a path with `ping`, see [Using the ping Command to Help Determine the Correct MTU Setting for Your Network](/ping-mtu-linux/), and for general Cilium debugging, the [Cilium Troubleshooting Guide](/post/cilium-troubleshooting/).

## References

- [Cilium documentation: Routing and MTU](https://docs.cilium.io/en/stable/network/concepts/routing/)
- [Cilium Helm reference: `MTU`](https://docs.cilium.io/en/stable/helm-reference/)
- [RKE2: Customizing packaged components with HelmChartConfig](https://docs.rke2.io/helm#customizing-packaged-components-with-helmchartconfig)
- [Linux kernel `net/bridge/br_if.c`](https://github.com/torvalds/linux/blob/master/net/bridge/br_if.c): `br_mtu_auto_adjust()`, `br_mtu_min()`
- [CNI bridge plugin: `mtu` option](https://www.cni.dev/plugins/current/main/bridge/)
- [KubeVirt user guide: interfaces and networks](https://kubevirt.io/user-guide/network/interfaces_and_networks/)
- [Longhorn settings reference: Engine to Replica Timeout](https://longhorn.io/docs/latest/references/settings/)
- [CloudNativePG: Declarative hibernation](https://cloudnative-pg.io/documentation/current/declarative_hibernation/)
