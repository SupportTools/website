---
title: "Kubernetes v1.32 (Penelope) vs v1.33 (Octarine): Complete Feature Comparison and Upgrade Guide"
date: 2025-07-01T09:00:00-05:00
draft: false
tags: ["Kubernetes", "v1.32", "v1.33", "Release Features", "Stable Features", "Beta Features", "Alpha Features", "Deprecations", "Upgrade Guide"]
categories:
- Kubernetes
- Release Notes
- Best Practices
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive comparison of Kubernetes v1.32 'Penelope' and v1.33 'Octarine' releases with detailed analysis of stable, beta, and alpha features. Essential guide for planning your cluster upgrades with practical implementation examples."
more_link: "yes"
url: "/kubernetes-v1-32-v1-33-comparison-key-features/"
---

![Kubernetes Release Comparison](/images/posts/kubernetes-releases/k8s-v1-32-v1-33-comparison.svg)

This comprehensive guide compares Kubernetes v1.32 "Penelope" and v1.33 "Octarine: The Color of Magic" releases, analyzing key features by maturity level with practical implementation examples to help you plan your upgrade strategy.

<!--more-->

# [Kubernetes v1.32 and v1.33 Feature Comparison](#kubernetes-feature-comparison)

Kubernetes continues its rapid evolution with two significant releases: v1.32 "Penelope" (released December 2024) and v1.33 "Octarine: The Color of Magic" (released April 2025). In this detailed comparison, we'll explore the key features, enhancements, and deprecations in both releases to help you make informed upgrade decisions.

## [Release Overview and Themes](#release-overview)

### [Kubernetes v1.32 "Penelope"](#v1-32-overview)

The "Penelope" release (named after the character in Homer's Odyssey who weaves and unweaves a tapestry) introduced 44 enhancements:
- 13 features graduated to Stable (GA)
- 12 features entered Beta
- 19 features introduced in Alpha

The core themes of v1.32 focused on:
- Enhanced resource management
- Improved API machinery
- Better storage capabilities
- Refined security controls

### [Kubernetes v1.33 "Octarine: The Color of Magic"](#v1-33-overview)

The "Octarine" release (named after Terry Pratchett's Discworld series) delivered 64 enhancements:
- 18 features graduated to Stable (GA)
- 20 features entered Beta
- 24 features introduced in Alpha
- 2 features deprecated or withdrawn

The v1.33 release emphasized:
- Application development improvements
- Operational excellence
- Enhanced security posture
- Performance optimizations
- User experience refinements

## [Features Comparison by Maturity Level](#feature-comparison)

### [Stable (GA) Features Comparison](#stable-features)

| Feature | v1.32 | v1.33 | Impact |
|---------|-------|-------|--------|
| Sidecar Containers | Not GA | ✅ GA | First-class support for auxiliary containers in pods |
| Custom Resource Field Selectors | ✅ GA | ✅ GA | Efficient filtering of custom resources |
| Memory Manager | ✅ GA | ✅ GA | Improved memory allocation at the node level |
| StatefulSet PVC Auto-Removal | ✅ GA | ✅ GA | Simplified storage lifecycle management |
| Service Account Token Improvements | ✅ GA | ✅ GA | Enhanced security with node info in tokens |
| Structured Authorization Config | ✅ GA | ✅ GA | Support for complex multi-tenant authorization setups |
| Multiple Service CIDRs | Beta | ✅ GA | Scale-out of service IP address space |
| Topology Aware Routing | Beta | ✅ GA | Preference for nearest endpoints (PreferClose) |
| Volume Populators | Beta | ✅ GA | Pre-load volumes from external sources |
| Job Enhancements (backoffLimit per index) | Beta | ✅ GA | More resilient job processing |
| kubectl Subresource Support | Beta | ✅ GA | Full API interaction with subresources |

#### [Notable v1.33 GA Feature: Sidecar Containers](#sidecar-containers)

The long-awaited sidecar container pattern officially reaches GA status in v1.33, bringing formal support for the widely-used pattern of auxiliary containers that provide supporting functionality to applications.

Before v1.33, implementing sidecars often relied on lifecycle management workarounds:

```yaml
# Pre-v1.33 sidecar workaround
apiVersion: v1
kind: Pod
metadata:
  name: web-app-with-sidecar
spec:
  containers:
  - name: web-app
    image: nginx:1.25
    # Main container configuration
  - name: log-collector
    image: fluent/fluent-bit:1.9
    # Sidecar configuration
    command: ["/bin/sh", "-c", "while true; do sleep 3600; done"]
    # Keep-alive hack to prevent container termination
```

With v1.33, you can now use the formal sidecar pattern:

```yaml
# v1.33 official sidecar support
apiVersion: v1
kind: Pod
metadata:
  name: web-app-with-sidecar
spec:
  containers:
  - name: web-app
    image: nginx:1.25
    # Main container configuration
  - name: log-collector
    image: fluent/fluent-bit:1.9
    # Official sidecar container
    restartPolicy: Always
```

This native implementation provides better lifecycle management and interaction with pod termination processes.

### [Beta Features Comparison](#beta-features)

| Feature | v1.32 | v1.33 | Impact |
|---------|-------|-------|--------|
| Volume Group Snapshot | Beta | Beta | Consistent snapshots across multiple volumes |
| Recover from Volume Expansion Failures | Beta | Beta | Improved storage resilience |
| Per-Plugin Scheduler Requeueing | Beta | Beta | Better scheduling performance |
| Anonymous Auth Restrictions | Beta | Beta | Limited /healthz access for security |
| Relaxed Environment Variable Validation | Beta | Beta | Support for more env var naming patterns |
| Structured DRA Parameters | Beta | Beta | More efficient resource allocation planning |
| User Namespaces in Pods | Alpha | Beta (on by default) | Enhanced container isolation security |
| Asynchronous Preemption | Alpha | Beta | Faster pod scheduling |
| In-place Pod Vertical Scaling | Alpha | Beta | Resize pod resources without restart |
| Windows DSR Support | Alpha | Beta | Improved Windows networking performance |

#### [Notable v1.33 Beta Feature: In-place Pod Vertical Scaling](#vertical-scaling)

In v1.33, the ability to resize pod CPU and memory allocations without restarting pods moves to beta. This feature significantly improves workload availability during resource adjustments.

```yaml
# v1.33 in-place CPU/memory scaling
apiVersion: v1
kind: Pod
metadata:
  name: resizable-app
  annotations:
    resize.kubernetes.io/cpu: "true"
    resize.kubernetes.io/memory: "true"
spec:
  containers:
  - name: app
    image: my-application:1.0
    resources:
      requests:
        cpu: "1"
        memory: "1Gi"
      limits:
        cpu: "2"
        memory: "2Gi"
```

To resize the pod, patch its resource specification:

```bash
kubectl patch pod resizable-app --type='json' -p='[
  {"op": "replace", "path": "/spec/containers/0/resources/requests/cpu", "value": "2"},
  {"op": "replace", "path": "/spec/containers/0/resources/limits/cpu", "value": "4"}
]'
```

The kubelet will apply these changes without restarting the pod, avoiding application disruption.

### [Alpha Features Comparison](#alpha-features)

| Feature | v1.32 | v1.33 | Impact |
|---------|-------|-------|--------|
| Pod-Level Resource Requests | Alpha | Alpha | Share CPU/memory limits across containers |
| Mutating Admission via CEL | Alpha | Alpha | Declarative sidecar injection, defaulting |
| Structured Namespace Deletion | Not present | Alpha | Deterministic namespace resource removal |
| Custom Container Stop Signals | Not present | Alpha | More graceful container termination |
| `.kuberc` for kubectl Preferences | Not present | Alpha | Separate UI settings from kubeconfig |
| Node Topology Labels via Downward API | Not present | Alpha | Better hardware topology awareness |
| PSI Metrics | Not present | Alpha | Enhanced pressure stall information |

#### [Notable v1.33 Alpha Feature: `.kuberc` for kubectl Preferences](#kuberc)

In v1.33, kubectl introduces a new configuration mechanism that separates user preferences from cluster connection details. This keeps your kubeconfig focused on cluster access while storing preferences separately.

Create a `.kuberc` file to customize kubectl behavior:

```yaml
# ~/.kuberc example
preferences:
  colorMode: "on"
  sortBy:
    name: true
  outputStyle:
    default: yaml
  
aliases:
  - name: "kn"
    command: ["kubectl", "get", "nodes"]
  - name: "kp"
    command: ["kubectl", "get", "pods", "--all-namespaces"]
  
default-flags:
  - name: "get"
    flags: ["--show-kind=true", "--no-headers=false"]
```

This separation makes it easier to share cluster connection details without overwriting personal preferences.

## [Deprecations and Removals](#deprecations)

### [v1.32 Deprecations](#v1-32-deprecations)

- **flowcontrol.apiserver.k8s.io/v1beta3** API removed - Update to v1 stable API
- **Original DRA implementation** withdrawn - Replaced by Structured Parameter support
- **Endpoints API (v1)** deprecated - Begin migrating to EndpointSlices

### [v1.33 Deprecations](#v1-33-deprecations)

- **Endpoints API** further deprecation - Now emits warnings
- **status.nodeInfo.kubeProxyVersion** removed - No longer populated
- **In-tree gitRepo Volume Driver** fully removed - Use init containers instead
- **Windows Host Networking** removed - Due to stability issues

## [Transitioning Between Releases](#transition-guide)

### [Preparation Before Upgrading](#upgrade-preparation)

1. **API Compatibility Check**:
   ```bash
   # Check for use of deprecated APIs
   kubectl get pods --all-namespaces -o jsonpath='{range .items[*]}{.apiVersion}{"\n"}{end}' | sort | uniq -c
   
   # Look for Endpoints API direct usage
   kubectl get endpoints --all-namespaces -o name | wc -l
   ```

2. **Feature Gate Analysis**:
   ```bash
   # Check enabled feature gates
   kubectl get cm -n kube-system kubeadm-config -o yaml | grep featureGates
   ```

3. **Review Workload Compatibility**:
   - Check for Windows container usage
   - Identify StatefulSets managing PVCs
   - Locate workloads using sidecar patterns

### [Adoption Strategy by Feature](#adoption-strategy)

#### [Immediate Adoption (Low Risk)](#low-risk)

These features can be safely adopted immediately after upgrade:

- **Sidecar Containers** (v1.33): Formalize existing sidecar patterns
- **StatefulSet PVC Auto-Removal** (v1.32+): Enable for simpler storage cleanup
- **kubectl Subresource Support** (v1.33): Use for status/scale operations

#### [Staged Adoption (Medium Risk)](#medium-risk)

These features benefit from testing before widespread use:

- **Memory Manager** (v1.32+): Gradually enable on non-critical nodes first
- **In-place Pod Vertical Scaling** (v1.33 Beta): Test with non-critical workloads

#### [Cautious Adoption (High Risk)](#high-risk)

These features require careful planning:

- **User Namespaces** (v1.33 Beta): Test extensively with security-sensitive workloads
- **Dynamic Resource Allocation Changes** (v1.32+): Thoroughly test for custom resource requirements

## [Performance Considerations](#performance)

The v1.33 release includes several performance enhancements worth highlighting:

1. **Asynchronous Preemption**:
   - Scheduler throughput improved by up to 30% in high-preemption scenarios
   - Particularly beneficial for large clusters with frequent resource contention

2. **nftables-based kube-proxy**:
   - Up to 40% reduced CPU usage for service handling
   - Better scalability for environments with large service counts

3. **Improved Queue Scheduling**:
   - Reduced idle time when activeQ is empty
   - Better handling of backoff queues

## [Upgrade Path Recommendations](#upgrade-path)

### [For v1.31 Clusters](#from-v1-31)

**Recommended path**: v1.31 → v1.32 → v1.33
- Allows incremental adaptation to feature changes
- Provides opportunity to test v1.32 stable features before adopting v1.33 beta features

### [For v1.32 Clusters](#from-v1-32)

**Recommended path**: Direct upgrade to v1.33
- Focus on testing sidecar containers and in-place vertical scaling
- Prepare for Endpoints API deprecation

### [For Production Environments](#production-upgrade)

Follow this process for production upgrades:

1. Test in development environment
2. Update monitoring to track new metrics
3. Upgrade control plane components first
4. Perform canary rollout of worker nodes
5. Validate core workload performance
6. Gradually adopt GA features
7. Selectively test beta features

## [Key Takeaways](#key-takeaways)

1. **Kubernetes v1.33** brings significant operational improvements with sidecar containers and in-place scaling
2. **Resource Management** gains efficiency with Dynamic Resource Allocation and Memory Manager
3. **Security Posture** improves through user namespaces and enhanced service account tokens
4. **Developer Experience** benefits from better kubectl configuration and CEL-based admission
5. **Windows Workloads** gain networking performance improvements with DSR support

The transition from v1.32 to v1.33 represents substantial maturation in Kubernetes, with many long-awaited features reaching stable status. Organizations should begin testing these capabilities now to fully leverage their benefits in production environments.

## [Further Reading](#further-reading)

- [Official Kubernetes v1.32 Release Notes](https://kubernetes.io/blog/2024/12/11/kubernetes-v1-32-release/)
- [Official Kubernetes v1.33 Release Notes](https://kubernetes.io/blog/2025/04/23/kubernetes-v1-33-release/)
- [Kubernetes Enhancement Proposals (KEPs)](https://github.com/kubernetes/enhancements/tree/master/keps)
- [Deprecated API Migration Guide](https://kubernetes.io/docs/reference/using-api/deprecation-guide/)
- [Feature Gates Reference](https://kubernetes.io/docs/reference/command-line-tools-reference/feature-gates/)