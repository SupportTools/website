---
title: "Cilium Troubleshooting Guide: Commands That Work in 2026"
date: 2025-03-14T14:00:00-05:00
lastmod: 2026-10-23
draft: false
tags: ["Cilium", "Kubernetes", "Networking", "eBPF", "Troubleshooting"]
categories:
- Networking
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Troubleshoot Cilium 1.16 to 1.20: run cilium-dbg on the right node, find drops with Hubble, debug policy, DNS and services, and collect a sysdump."
more_link: "yes"
quick_fix: |
  Run `cilium status --wait` and `cilium connectivity test` from your workstation with the cilium CLI.
  Then exec into the agent **on the affected node** (not a random `ds/cilium` pod):
  `kubectl -n kube-system exec <cilium-pod-on-that-node> -c cilium-agent -- cilium-dbg status --verbose`.
  Find the dropped packets with `hubble observe --verdict DROPPED --pod <ns>/<pod>` or `cilium-dbg monitor --type drop`; the drop reason tells you whether it is policy, routing or a missing endpoint.
  Since Cilium 1.15 the in-pod CLI is `cilium-dbg`, not `cilium`.
---

Troubleshooting Cilium is mostly about running the right command in the right place. This guide is a working reference for current Cilium releases (1.16 through 1.20, with 1.20.3 the current stable at the time of this update): the cilium CLI on your workstation, `cilium-dbg` inside the agent, and Hubble for flows. It builds on our earlier [Cilium Troubleshooting Guide](/post/cilium-troubleshooting/).

<!--more-->

## What changed since older Cilium guides

- **`cilium` inside the agent pod is now `cilium-dbg`.** The in-agent debug CLI was renamed in Cilium 1.15. The name `cilium` now refers to the separate [cilium CLI](https://github.com/cilium/cilium-cli) you install on your workstation (`cilium status`, `cilium connectivity test`, `cilium sysdump`, `cilium hubble port-forward`, `cilium config`).
- **Kernel requirement.** Current Cilium requires Linux 5.10 or later, or an equivalent backport such as RHEL 8.10's 4.18 kernel ([system requirements](https://docs.cilium.io/en/stable/operations/system_requirements/)).
- **Sysdump.** The old standalone `cilium-sysdump` zip is gone; use `cilium sysdump`.
- **Upgrades.** Only consecutive minor upgrades are tested (1.19 to 1.20, not 1.18 to 1.20).

Many commands in older blog posts, including the 2025 version of this page, used flags and subcommands that do not exist (`cilium kernel-check`, `cilium monitor -n <namespace>`, `cilium proxy get access-log`). The commands below are taken from the current Cilium docs and CLI help.

## Architecture in one minute

- **cilium-agent** (DaemonSet): programs eBPF on each node, manages endpoints, identities, policy and service load balancing.
- **cilium-operator** (Deployment): cluster-wide tasks such as IPAM allocation and identity garbage collection.
- **cilium-envoy** (DaemonSet in recent releases, or embedded): L7 policy, Ingress and Gateway API.
- **Hubble** (in the agent) plus **hubble-relay** and **hubble-ui**: flow visibility.

Packet paths to keep in mind:

1. **Pod egress**: pod, veth, eBPF program on the host side of the veth, routing (native routing or VXLAN/Geneve tunnel), destination.
2. **Pod ingress**: node interface, eBPF on the node interface, veth, pod.
3. **Service access**: the destination ClusterIP is translated to a backend by eBPF at the socket or TC layer, before the packet leaves the pod's node.

## Step 0: Talk to the agent on the right node

`kubectl exec ds/cilium` picks an arbitrary agent pod, which is the wrong one for node-specific problems. Select the agent on the node that runs the affected pod:

```bash
NODE=$(kubectl get pod <pod> -n <namespace> -o jsonpath='{.spec.nodeName}')
CILIUM_POD=$(kubectl -n kube-system get pod -l k8s-app=cilium --field-selector spec.nodeName="$NODE" -o name)

cdbg() { kubectl -n kube-system exec "$CILIUM_POD" -c cilium-agent -- cilium-dbg "$@"; }

cdbg status --verbose
```

The rest of this guide uses `cdbg` for `cilium-dbg` on the selected node. On RKE2 Cilium also runs in `kube-system`, installed by the `rke2-cilium` chart.

## Cluster-level diagnostics

### Overall health

```bash
cilium status --wait
kubectl -n kube-system get pods -l k8s-app=cilium -o wide
kubectl -n kube-system get pods -l name=cilium-operator -o wide
```

`cilium status` summarizes agent, operator, Hubble and Envoy readiness and any errors per node. On a single node, `cdbg status --verbose` shows:

- **Kubernetes** API connectivity and **KVStore** (only relevant if you run an external etcd kvstore).
- **Controller Status**: should read `0/N failing`. Any failing controller is named with its last error.
- **Proxy Status**, **IPAM** allocation, **Encryption**, and **Cluster health** (node to node reachability).

Node to node health is checked by `cilium-health`:

```bash
kubectl -n kube-system exec "$CILIUM_POD" -c cilium-agent -- cilium-health status --verbose
```

Unreachable nodes here usually mean a firewall blocking VXLAN (UDP 8472) or Geneve (UDP 6081), the health port (TCP 4240), or an MTU mismatch.

### Operator problems

```bash
kubectl -n kube-system logs deploy/cilium-operator --tail=100
kubectl -n kube-system describe deploy/cilium-operator
```

Common causes: RBAC or API connectivity errors, IPAM exhaustion (no more pod CIDRs to hand out), and OOMKilled pods on large clusters.

### Logs and debug mode

```bash
kubectl -n kube-system logs "$CILIUM_POD" -c cilium-agent --tail=200 | grep -E 'level=(error|warn)'
```

To enable debug logging, set it in the `cilium-config` ConfigMap through the cilium CLI (which restarts the agents) or through your Helm values (`debug.enabled=true`, `debug.verbose=datapath`):

```bash
cilium config set debug true
cilium config set debug-verbose datapath
kubectl -n kube-system get cm cilium-config -o yaml | grep debug
```

Turn it off again afterwards; datapath debug is very noisy. On RKE2, set these through the `rke2-cilium` `HelmChartConfig` instead, or the Helm controller will revert them.

### Services: Kubernetes vs the datapath

```bash
kubectl get svc,endpointslices -n <namespace>
cdbg service list
cdbg bpf lb list
```

A Service missing from `cdbg service list`, or a backend missing from its list, means the agent has not processed the update. Check the agent log for API errors before restarting anything.

### eBPF maps

```bash
cdbg map list
cdbg bpf ct list global | wc -l
```

`cdbg map list` shows each map with its entry count. Watch the `cilium_bpf_map_pressure` metric for maps that are close to full; a full connection tracking or NAT map causes random new-connection failures. Size them with `bpf.mapDynamicSizeRatio` or the specific `bpf.*Max` Helm values.

## Pod connectivity

### Find the drop

Hubble is the fastest way to see what happens to a flow:

```bash
cilium hubble port-forward &
hubble observe --pod <namespace>/<pod> --last 50
hubble observe --verdict DROPPED --namespace <namespace> -f
```

Without Hubble, use the monitor on the node of the source or destination pod:

```bash
cdbg endpoint list
cdbg monitor --type drop
cdbg monitor --related-to <endpoint-id>
```

The drop reason is the key:

| Drop reason | Usual cause |
|---|---|
| `Policy denied` | A network policy does not allow the flow (see policy section) |
| `Stale or unroutable IP` | Traffic to an IP that is no longer a known endpoint, often after pod churn |
| `CT: Map insertion failed` | Connection tracking map full |
| `Invalid source ip` or `Unsupported L3 protocol` | Spoofed or unexpected traffic, or a misconfigured multi-homed pod |
| `No tunnel/encapsulation endpoint` | The agent does not know the remote node; check `cilium-health` and node CIDRs |

### Structured connectivity test

```bash
cilium connectivity test
```

This creates test workloads in the `cilium-test-*` namespaces, runs pod to pod, pod to Service, node port, egress and policy scenarios, and cleans up after itself on success. Use `--test <name>` to run a subset. The [troubleshooting docs](https://docs.cilium.io/en/stable/operations/troubleshooting/) still publish the older static `connectivity-check.yaml` manifest per release if you cannot run the CLI.

### MTU and encapsulation

Large requests that hang while small ones work point to MTU. With VXLAN or Geneve, the pod MTU must be at least 50 bytes smaller than the underlay MTU. Check what Cilium chose:

```bash
cdbg status --verbose | grep -i mtu
kubectl -n kube-system get cm cilium-config -o yaml | grep -i mtu
```

### DNS problems

Cilium only proxies DNS when an FQDN policy (`toFQDNs`) or DNS visibility rule applies to the pod. Check CoreDNS first (see [CoreDNS and NodeLocal DNSCache: Troubleshoot and Monitor](/coredns-nodelocaldns-troubleshooting-monitoring/)), then Cilium:

```bash
hubble observe --pod <namespace>/<pod> --protocol dns
cdbg fqdn cache list
```

If pods with FQDN policies cannot resolve, make sure the policy also allows egress to `kube-dns` on port 53 with a `dns` rule, otherwise the DNS request itself is dropped. If you use NodeLocal DNSCache with kube-proxy replacement, it needs a Local Redirect Policy.

## Policy troubleshooting

### Audit mode

Policy audit mode reports what would be denied without dropping it. Enable it cluster-wide with `cilium config set policy-audit-mode true` (or the Helm value `policyAuditMode=true`), then look for `audit` verdicts:

```bash
hubble observe --verdict AUDIT --namespace <namespace>
```

Turn it off when you are done; while it is on, policies do not block anything.

### Step-by-step policy debugging

1. **Labels on both pods**:

   ```bash
   kubectl get pod <source-pod> -n <ns> --show-labels
   kubectl get pod <destination-pod> -n <ns> --show-labels
   ```

2. **Identities and endpoints**:

   ```bash
   cdbg endpoint list
   cdbg identity list
   ```

3. **Policies that apply**:

   ```bash
   kubectl get networkpolicy,ciliumnetworkpolicy -n <namespace>
   kubectl get ciliumclusterwidenetworkpolicy
   cdbg policy selectors
   cdbg endpoint get <endpoint-id>
   cdbg bpf policy get <endpoint-id>
   ```

   The short names are `cnp` and `ccnp`.

4. **Watch verdicts while you reproduce**:

   ```bash
   cdbg monitor --type policy-verdict
   ```

5. **Test with a narrow temporary allow policy**:

   ```yaml
   apiVersion: cilium.io/v2
   kind: CiliumNetworkPolicy
   metadata:
     name: temp-allow
     namespace: <namespace>
   spec:
     endpointSelector:
       matchLabels:
         app: <destination-app>
     ingress:
     - fromEndpoints:
       - matchLabels:
           app: <source-app>
   ```

   If this fixes it, the original policy's selectors or ports are wrong. Delete the temporary policy afterwards.

Remember that as soon as any policy selects an endpoint in a direction (ingress or egress), everything not allowed in that direction is denied.

## Performance

### Connection tracking

```bash
cdbg bpf ct list global | wc -l
kubectl -n kube-system get cm cilium-config -o yaml | grep -E 'ct-|conntrack'
```

Flushing the table (`cdbg bpf ct flush global`) breaks established connections on that node; use it only as a last resort during an incident.

### Agent resources

```bash
kubectl -n kube-system top pod -l k8s-app=cilium
kubectl -n kube-system describe pod "${CILIUM_POD#pod/}" | grep -A3 -i 'last state'
```

OOMKilled agents or heavy CPU throttling show up as slow endpoint regeneration and delayed policy updates. Check `cilium_endpoint_regeneration_time_stats_seconds` and `cilium_endpoint_regenerations_total` in Prometheus.

### Useful metrics

- `cilium_drop_count_total` by `reason` and `direction`
- `cilium_bpf_map_pressure`
- `cilium_endpoint_regenerations_total` by `outcome`
- `cilium_unreachable_nodes`
- `cilium_datapath_errors_total`

## L7, Envoy, Ingress and Gateway API

```bash
cilium status | grep -i envoy
kubectl -n kube-system get pods -l k8s-app=cilium-envoy -o wide
kubectl -n kube-system logs ds/cilium-envoy --tail=100
hubble observe --type l7 --namespace <namespace>
cdbg monitor --type l7
```

For HTTP policy problems: confirm that traffic reaches Envoy (L7 flows appear in Hubble), that the method, path and headers match the rule exactly, and that the L4 port in the rule matches the container port. If you manage Cilium with Argo CD on RKE2, see [Fixing Argo CD Out-of-Sync Due to Cilium Identity on RKE2](/cilium-identity-argo-out-of-sync-rke2/) for a related gotcha.

## Upgrades and rollback

Before a minor upgrade, run the preflight check from the [upgrade guide](https://docs.cilium.io/en/stable/operations/upgrade/), which pre-pulls images and validates existing policies:

```bash
helm template cilium/cilium --version 1.20.3 \
   --namespace kube-system \
   --set preflight.enabled=true \
   --set agent=false \
   --set operator.enabled=false \
   > cilium-preflight.yaml
kubectl create -f cilium-preflight.yaml
# wait until the preflight DaemonSet and Deployment are ready, then
kubectl delete -f cilium-preflight.yaml
```

Upgrade with a values file, not `--reuse-values`, and set `upgradeCompatibility` to the version the cluster was first installed with:

```bash
helm upgrade cilium cilium/cilium --version 1.20.3 \
   --namespace kube-system \
   -f my-values.yaml \
   --set upgradeCompatibility=1.X
```

Read the upgrade notes for every minor version you cross. To roll back, `helm rollback cilium <revision> -n kube-system`, then `cilium status --wait`.

On RKE2 the Cilium version is tied to the RKE2 release and configured through the `rke2-cilium` `HelmChartConfig`, so upgrade RKE2 rather than running `helm upgrade` yourself.

## Collect everything: sysdump

```bash
cilium sysdump
# Large clusters: limit nodes and log size
cilium sysdump --node-list <node1>,<node2> --logs-limit-bytes 1073741824
```

The resulting zip contains agent and operator logs, `cilium-dbg` output from every node, BPF maps, Hubble flows and the relevant Kubernetes objects. Attach it to GitHub issues or support cases.

## Case studies

### Case 1: Intermittent pod connectivity

1. `hubble observe --verdict DROPPED -f` while reproducing.
2. `cdbg endpoint list` on both nodes: look for endpoints not in `ready` state.
3. `cilium-health status --verbose` for node to node problems.
4. `cdbg status --verbose` for failing controllers.

Common causes: full CT or NAT maps, MTU mismatch on a tunnel, an endpoint stuck regenerating, or a policy that only matches some replicas' labels.

### Case 2: Service load balancing failures

1. `cdbg service list` and `cdbg bpf lb list` for the ClusterIP.
2. `kubectl get endpointslices` to compare with Kubernetes.
3. `hubble observe --to-ip <cluster-ip>` or `--to-service <ns>/<svc>`.

Common causes: pods not Ready (so they are not in EndpointSlices), Service selector mismatch, `externalTrafficPolicy: Local` on a node without local backends, or a full LB map.

### Case 3: Policy enforcement inconsistencies

1. `cdbg policy selectors` to see which identities each selector matches.
2. `cdbg monitor --type policy-verdict` during traffic.
3. `cdbg identity list` to confirm identities match current labels.

Common causes: label typos, namespace selectors missing the `k8s:io.kubernetes.pod.namespace` label, policies in both `NetworkPolicy` and `CiliumNetworkPolicy` form that combine unexpectedly, and stale identities after a label change (recreate the pod).

## FAQ

### Why does `kubectl exec ds/cilium -- cilium status` fail with "executable file not found"?

On Cilium 1.15 and later, the binary inside the agent is `cilium-dbg`. Use `cilium-dbg status`, or run `cilium status` with the cilium CLI on your workstation.

### Which Cilium versions are supported?

The Cilium project supports the three most recent minor releases. With 1.20 current, that is 1.18, 1.19 and 1.20. Check the [release notes](https://github.com/cilium/cilium/releases) for your exact patch level.

### How do I debug Cilium on a node that is NotReady?

Use `kubectl debug node/<node> -it --image=<image-with-tools>` for host-level checks, and read the agent log with `kubectl -n kube-system logs <cilium-pod> -c cilium-agent --previous`. If the agent never starts, check the init containers (`mount-cgroup`, `apply-sysctl-overwrites`, `mount-bpf-fs`, `clean-cilium-state`) with `kubectl describe pod`.

## Related guides

- [Cilium Troubleshooting Guide (original)](/post/cilium-troubleshooting/)
- [Running K3s in an IPv6-Only Environment with Cilium](/k3s-ipv6-cilium/)
- [CoreDNS and NodeLocal DNSCache: Troubleshoot and Monitor](/coredns-nodelocaldns-troubleshooting-monitoring/)
- [Fixing Longhorn Volumes That Won't Attach](/post/fixing-longhorn-volume-issues/)
