---
title: "Fixing Helm Upgrades After Kubernetes v1.25: The PDB API Version Trap"
date: 2026-04-16T09:00:00-05:00
draft: false
tags: ["Kubernetes", "Helm", "Upgrades", "PodDisruptionBudget", "v1.25", "API Deprecation", "Troubleshooting"]
categories:
- Kubernetes
- Troubleshooting
author: "Matthew Mattox - mmattox@support.tools"
description: "How to fix Helm upgrade failures in Kubernetes v1.25+ due to removed PodDisruptionBudget API versions using helm-mapkubeapis, with step-by-step instructions and real-world examples"
more_link: "yes"
url: "/fixing-helm-upgrades-kubernetes-v1-25-pdb-api/"
---

During a recent production cluster upgrade from v1.23 to v1.25, we hit a brick wall with Helm that temporarily halted our maintenance window. All our chart updates were properly tested, our backups were verified, and our rollback plan was ready—but Helm stubbornly refused to upgrade critical workloads with a cryptic error about PodDisruptionBudgets. Here's what happened, how we solved it, and the important lessons that will save you considerable headaches in your future upgrades.

<!--more-->

## The Invisible Landmine in Kubernetes v1.25

Kubernetes v1.25 introduced a significant breaking change that wasn't immediately obvious from the release notes: it completely removed the `policy/v1beta1` API version for PodDisruptionBudgets (PDBs). Unlike many API deprecations where the old version continues to work, this one was a hard removal.

When we tried to run our standard Helm upgrades after the cluster upgrade, we were greeted with this error:

```
Error: UPGRADE FAILED: resource mapping not found for name: "redis-ha-pdb" namespace: "database" from "": no matches for kind "PodDisruptionBudget" in version "policy/v1beta1"
ensure CRDs are installed first
```

What made this particularly confusing was that:

1. We had already updated our chart templates to use `policy/v1`
2. The error appeared even for charts that were correctly using the new API version
3. Rolling back to a previous release didn't help

After some investigation, we discovered the root cause: Helm doesn't just care about what's in your current chart templates—it also references API versions stored in its release history metadata.

## Understanding the Problem: Helm's Release Metadata

Helm maintains detailed records of every resource deployed with each release. When you run a `helm upgrade`, it compares these records with what's currently in the cluster and what's in your new chart version.

Here's the key insight: even if your current chart uses the correct API versions, Helm's release metadata might still reference resources using old, removed API versions from previous deployments.

You can confirm this by checking the release metadata:

```bash
helm get manifest [release-name] --revision=1
```

In our case, earlier releases of our charts had used `policy/v1beta1` for PDBs. Even though our current chart versions were updated, Helm's internal references to those resources were still pointing to the removed API.

## The Solution: helm-mapkubeapis

After researching solutions, we found [helm-mapkubeapis](https://github.com/helm/helm-mapkubeapis), a Helm plugin specifically designed to fix these API version references in Helm's internal metadata.

### Installing the Plugin

First, install the plugin (make sure to use v0.4.1 or later):

```bash
helm plugin install https://github.com/helm/helm-mapkubeapis
```

### Checking What Needs to be Fixed

Before making any changes, run a dry-run to see what would be updated:

```bash
helm mapkubeapis --dry-run [release-name] --namespace [namespace]
```

The output looks something like this:

```
2025/08/01 14:23:53 Mapping release: database/redis-ha
2025/08/01 14:23:53 Found deprecated or removed API:
2025/08/01 14:23:53 "apiVersion: policy/v1beta1" => "apiVersion: policy/v1"
2025/08/01 14:23:53 Kind: PodDisruptionBudget Name: redis-ha-pdb
2025/08/01 14:23:53 DRY-RUN: Changes will not be applied
```

### Fixing the Release Metadata

Once you've confirmed the changes look good, run the command without the `--dry-run` flag:

```bash
helm mapkubeapis [release-name] --namespace [namespace]
```

After running this command, Helm creates a new release revision with the updated API references, allowing your future upgrades to proceed normally. The output confirms the update:

```
2025/08/01 14:25:12 Mapping release: database/redis-ha
2025/08/01 14:25:12 Found deprecated or removed API:
2025/08/01 14:25:12 "apiVersion: policy/v1beta1" => "apiVersion: policy/v1"
2025/08/01 14:25:12 Kind: PodDisruptionBudget Name: redis-ha-pdb
2025/08/01 14:25:12 Release 'redis-ha' with version '16' updated successfully
```

## Real-World Implementation: Our Process

For our production clusters, we developed a systematic approach to fix all affected releases:

1. **Identify all releases using PDBs:**

```bash
for ns in $(kubectl get ns -o jsonpath='{.items[*].metadata.name}'); do
  echo "Namespace: $ns"
  helm list -n $ns | grep -v NAME
done
```

2. **Run mapkubeapis dry-run for each release:**

```bash
for release in $(helm list -n [namespace] -q); do
  echo "Checking $release..."
  helm mapkubeapis --dry-run $release -n [namespace]
done
```

3. **Apply fixes to affected releases:**

```bash
for release in redis-ha mongodb elasticsearch; do
  echo "Fixing $release..."
  helm mapkubeapis $release -n [namespace]
done
```

4. **Verify upgrades now work:**

```bash
helm upgrade redis-ha ./redis-ha-chart -n database
```

## Beyond PDBs: Other API Changes to Watch For

While this post focuses on the PDB issue, Kubernetes v1.25 also removed several other beta APIs:

- `batch/v1beta1` CronJob (use `batch/v1`)
- `discovery.k8s.io/v1beta1` EndpointSlice (use `discovery.k8s.io/v1`)
- `autoscaling/v2beta1` HorizontalPodAutoscaler (use `autoscaling/v2`)

The helm-mapkubeapis plugin can fix references to these APIs as well. If you're upgrading directly from an older version like v1.19 or v1.20 to v1.25+, you'll likely need to address all of these changes.

## Lessons Learned: Preventing This in the Future

After going through this experience, we've updated our Kubernetes upgrade process to include these steps:

1. **API Deprecation Audit:** Before upgrading, check the Kubernetes version's release notes specifically for API removals, not just deprecations.

2. **Helm Release Check:** Use this command to identify all API versions used by your Helm releases:

```bash
# Requires jq
for release in $(helm list -A -q); do
  ns=$(helm list -A | grep "^$release" | awk '{print $2}')
  helm get manifest $release -n $ns | grep -E "apiVersion:" | sort | uniq -c
done
```

3. **Proactive API Migration:** Update your charts to use stable API versions before the cluster upgrade, not during or after.

4. **Include mapkubeapis:** Add helm-mapkubeapis as a standard step in the upgrade procedure, especially when crossing significant version boundaries.

5. **Test in Dev:** Always test your upgrade path in a development environment with production-like workloads to catch these issues early.

## Making Future-Proof Charts

To avoid similar issues in future upgrades, I recommend these practices:

1. **Use API version conditionals in Helm templates:**

```yaml
{{- if .Capabilities.APIVersions.Has "policy/v1" }}
apiVersion: policy/v1
{{- else }}
apiVersion: policy/v1beta1
{{- end }}
kind: PodDisruptionBudget
```

2. **Document minimum Kubernetes versions for your charts**

Add a clear note in your chart's README.md and values.yaml:

```yaml
# Requires Kubernetes v1.25+ (uses policy/v1 for PodDisruptionBudgets)
```

3. **Use CI validation against multiple Kubernetes versions**

Set up your CI pipeline to test charts against different Kubernetes versions to catch compatibility issues early.

## Conclusion

The removal of the `policy/v1beta1` API in Kubernetes v1.25 serves as an important reminder that Kubernetes API stability isn't just about your current manifests—it also affects the metadata stored by tools like Helm. The helm-mapkubeapis plugin provides an elegant solution for handling these situations.

By understanding how Helm stores release information and preparing for API transitions, you can make your Kubernetes upgrades much smoother, avoiding those late-night emergency troubleshooting sessions during maintenance windows.

Have you encountered other challenges during Kubernetes version upgrades? I'd love to hear about your experiences and solutions in the comments below.