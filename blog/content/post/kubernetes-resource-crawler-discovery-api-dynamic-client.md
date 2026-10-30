---
title: "Building a Self-Updating Kubernetes Resource Crawler: Discovery API and Dynamic Client"
date: 2026-07-26T09:00:00-05:00
draft: false
tags: ["Kubernetes", "Go", "client-go", "Discovery API", "Dynamic Client", "CRDs", "RBAC", "GitOps", "DevOps"]
categories:
- Kubernetes
- Go
author: "Matthew Mattox - mmattox@support.tools"
description: "Enumerate every namespaced Kubernetes resource, CRDs included, with the Discovery API and dynamic client in Go, then harden the crawler against partial discovery, RBAC gaps, and unrestorable output."
more_link: "yes"
url: "/kubernetes-resource-crawler-discovery-api-dynamic-client/"
images: ["https://cdn.support.tools/posts/kubernetes-resource-crawler-discovery-api-dynamic-client/og-caec6a4655.jpg"]
---

Ask most engineers to export everything in a namespace and they reach for `kubectl get all -o yaml`. It feels comprehensive. It is not. The `all` category is a hardcoded shortlist inside kubectl, and it silently omits ConfigMaps, Secrets, PersistentVolumeClaims, Ingresses, NetworkPolicies, ServiceAccounts, RBAC bindings, and every Custom Resource an operator ever installed. Anything worth auditing is exactly the set `all` leaves out.

The correct approach is to ask the cluster what it can serve, then walk that list. The Kubernetes **Discovery API** enumerates every API group and resource the apiserver currently knows about, and the **dynamic client** lets you list any of them without compiling a single Go type. Composed together, they form a resource crawler that adapts to new CRDs the moment they are installed, with no code changes. A recent open source tool, [k8s-ns-dump-dynamic](https://github.com/devenkulkarni/k8s-ns-dump-dynamic), demonstrates the core loop in about 165 lines of Go and is a clean minimal example. This post builds that same crawler, then hardens it against the five ways the naive version fails in production: partial discovery, unbounded lists, swallowed permission errors, output that will not reapply, and client-side throttling.

<!--more-->

## Why kubectl get all Doesn't Mean All

The `all` in `kubectl get all` refers to a category defined server-side and consumed by kubectl, not to "every object in the namespace." Historically it maps to a small set: Pods, Services, DaemonSets, Deployments, ReplicaSets, StatefulSets, Jobs, CronJobs, and a handful of others. Run it against a namespace holding a cert-manager `Certificate`, an Istio `VirtualService`, and a stack of `ConfigMap` objects, and none of them appear in the output.

This is not a bug you can flag your way out of. There is no `--really-all` switch that reaches CRDs reliably, because kubectl cannot know ahead of time which Custom Resource Definitions a given cluster has installed. The information only exists at runtime, in the apiserver's discovery documents. To capture a complete picture you have to query those documents yourself and then list each resource type the cluster reports.

That runtime discovery is the entire reason the dynamic-client pattern exists. Instead of importing `appsv1.Deployment` and `corev1.ConfigMap` and every other type at compile time, you ask the apiserver for its resource catalog and iterate. A `Certificate` CRD installed five minutes ago is indistinguishable, to your crawler, from a built-in `Pod`. Both are just coordinates in the discovery output.

## The Discovery API and Dynamic Client

### The Two-Client Model

client-go gives you two fundamentally different ways to talk to the apiserver. The **typed client** (`kubernetes.Clientset`) is what most controllers use: strongly typed, ergonomic, and limited to the types compiled into your binary. The **dynamic client** (`dynamic.Interface`) trades compile-time types for runtime flexibility. It speaks in `GroupVersionResource` coordinates and returns `*unstructured.Unstructured` objects, which are essentially `map[string]interface{}` wrappers over the raw JSON.

For a crawler, the dynamic client has a decisive advantage beyond flexibility: **unstructured objects retain their `apiVersion` and `kind`.** The typed clients famously blank out `TypeMeta` on read, so a `Deployment` fetched with the typed client comes back with empty `Kind` and `APIVersion` fields, and any YAML you marshal from it is missing its type header. The minimal tool works around this for its one typed call by hand-setting the fields:

```go
// The typed client returns an empty TypeMeta, so these must be set manually
// before the namespace object marshals to valid, reappliable YAML.
ns.Kind = "Namespace"
ns.APIVersion = "v1"
```

The dynamic client needs none of that. Every unstructured object carries its own `apiVersion` and `kind` straight from the wire, which is exactly what you want when writing self-describing YAML files.

### Walking the Resource Catalog

The discovery client exposes `ServerPreferredNamespacedResources()`, which returns the preferred version of every namespaced resource the cluster serves. Each entry is an `APIResourceList` scoped to one `GroupVersion` and containing the individual resources in that group. Two pieces of filtering are essential before you try to list anything.

First, **skip sub-resources.** Discovery reports `pods/status`, `pods/exec`, `deployments/scale`, and similar entries alongside the real resources. They are identified by a `/` in the resource name and cannot be listed like collections. Second, **check the verbs.** Not every resource supports `list`; some are create-only or get-only. Attempting to list a resource that does not advertise the verb is a guaranteed error.

```go
package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/tools/clientcmd"
)

// buildClients wires up a discovery client and a dynamic client from a kubeconfig.
func buildClients(kubeconfig string) (*discovery.DiscoveryClient, dynamic.Interface, error) {
	cfg, err := clientcmd.BuildConfigFromFlags("", kubeconfig)
	if err != nil {
		return nil, nil, fmt.Errorf("loading kubeconfig: %w", err)
	}

	discoveryClient, err := discovery.NewDiscoveryClientForConfig(cfg)
	if err != nil {
		return nil, nil, fmt.Errorf("building discovery client: %w", err)
	}

	dynamicClient, err := dynamic.NewForConfig(cfg)
	if err != nil {
		return nil, nil, fmt.Errorf("building dynamic client: %w", err)
	}

	return discoveryClient, dynamicClient, nil
}

// listableGVRs turns a discovery result into a flat list of GroupVersionResource
// coordinates, dropping sub-resources and anything that cannot be listed.
func listableGVRs(lists []*metav1.APIResourceList) []schema.GroupVersionResource {
	var out []schema.GroupVersionResource

	for _, list := range lists {
		// GroupVersion is "apps/v1" or, for the core group, just "v1".
		gv, err := schema.ParseGroupVersion(list.GroupVersion)
		if err != nil {
			continue
		}

		for _, r := range list.APIResources {
			// Filter 1: sub-resources like pods/status are not collections.
			if strings.Contains(r.Name, "/") {
				continue
			}

			// Filter 2: only resources that advertise the "list" verb.
			if !containsVerb(r.Verbs, "list") {
				continue
			}

			out = append(out, schema.GroupVersionResource{
				Group:    gv.Group,
				Version:  gv.Version,
				Resource: r.Name,
			})
		}
	}

	return out
}

func containsVerb(verbs metav1.Verbs, want string) bool {
	for _, v := range verbs {
		if v == want {
			return true
		}
	}
	return false
}
```

Note the use of `schema.ParseGroupVersion` rather than a hand-rolled `strings.Split`. The minimal tool splits on `/` manually, which works, but the library function correctly handles the core-group case (`"v1"` parses to an empty group and version `v1`) and is the idiomatic choice.

## The Minimal Crawler

With discovery and filtering in place, the core loop is short. For each listable `GroupVersionResource`, list its instances in the target namespace, and write each object to a file named after the resource type and object name.

```go
import (
	"sigs.k8s.io/yaml"
)

// dumpNamespace lists every discoverable, listable resource in a namespace and
// writes each object to <outputDir>/<resource>/<name>.yaml.
func dumpNamespace(
	discoveryClient *discovery.DiscoveryClient,
	dynamicClient dynamic.Interface,
	namespace, outputDir string,
) error {
	lists, err := discoveryClient.ServerPreferredNamespacedResources()
	if err != nil {
		return fmt.Errorf("discovery failed: %w", err)
	}

	for _, gvr := range listableGVRs(lists) {
		list, err := dynamicClient.
			Resource(gvr).
			Namespace(namespace).
			List(context.Background(), metav1.ListOptions{})
		if err != nil {
			continue // naive: swallow the error and move on
		}
		if len(list.Items) == 0 {
			continue
		}

		resourceDir := filepath.Join(outputDir, gvr.Resource)
		if err := os.MkdirAll(resourceDir, 0o755); err != nil {
			return fmt.Errorf("creating %s: %w", resourceDir, err)
		}

		fmt.Printf("extracting %d %s\n", len(list.Items), gvr.Resource)
		for i := range list.Items {
			data, err := yaml.Marshal(list.Items[i].Object)
			if err != nil {
				continue
			}
			path := filepath.Join(resourceDir, list.Items[i].GetName()+".yaml")
			if err := os.WriteFile(path, data, 0o644); err != nil {
				return fmt.Errorf("writing %s: %w", path, err)
			}
		}
	}

	return nil
}
```

This works. Point it at a namespace on a healthy cluster from your laptop and it produces a tidy tree of YAML files, CRDs included. It is also the version that will quietly betray you the first time you run it against a real production cluster under a scoped ServiceAccount. Every `continue` in that loop is hiding a decision you have not made yet.

## Failure 1: Partial Discovery Is Not Optional

The single most common production surprise is that `ServerPreferredNamespacedResources()` returns an error. Not because discovery is broken, but because it is *designed* to return partial results alongside an error whenever any API group fails to respond. The upstream documentation is explicit: "the returned group and resource lists might be non-nil with partial results even in the case of non-nil error."

The usual culprit is an aggregated API server that is unhealthy. A dead `metrics-server`, a `prometheus-adapter` that lost its backend, or any `APIService` sitting in `Available: False` will cause discovery of that group to fail. Because metrics are served through the aggregation layer rather than stored in etcd, `metrics.k8s.io` failing is routine. The naive crawler treats this as fatal and aborts the entire dump, so one broken metrics deployment means you capture nothing, even though 99% of the cluster's resources were discovered perfectly.

client-go ships helpers specifically for this case. `IsGroupDiscoveryFailedError` tells you the error is the partial-failure kind rather than a genuine connection failure, and `GroupDiscoveryFailedErrorGroups` hands back the map of exactly which groups failed and why. The correct posture is to log the failed groups and proceed with the resources you did get.

```go
import "k8s.io/client-go/discovery"

// discoverTolerant returns whatever resources it can, treating a group-discovery
// failure as a warning rather than a fatal error.
func discoverTolerant(dc *discovery.DiscoveryClient) ([]*metav1.APIResourceList, error) {
	lists, err := dc.ServerPreferredNamespacedResources()
	if err != nil {
		// A hard error (network, auth) is still fatal.
		if !discovery.IsGroupDiscoveryFailedError(err) {
			return nil, fmt.Errorf("discovery failed: %w", err)
		}

		// Partial failure: report the broken groups, keep the good results.
		if groups, ok := discovery.GroupDiscoveryFailedErrorGroups(err); ok {
			for gv, gvErr := range groups {
				fmt.Fprintf(os.Stderr,
					"warning: skipping unavailable API group %s: %v\n", gv, gvErr)
			}
		}
	}

	// lists is populated with the successfully discovered resources either way.
	return lists, nil
}
```

This tolerant posture is not a personal preference; it is what mature tools in this space default to. The `ketall` kubectl plugin, which exists to list "really all" resources, ships a `--allow-incomplete` flag that shows partial results when discovery fails, and it is **enabled by default**. When the reference implementation of "list everything" makes fault tolerance the default rather than an opt-in, that is a strong signal that fail-fast is the wrong choice for a crawler.

## Failure 2: Unbounded Lists

The naive loop calls `List` with an empty `ListOptions`. That asks the apiserver for every object of that type in the namespace, in a single response, held entirely in memory on both ends. For most resources that is fine. For a namespace with tens of thousands of ConfigMaps or Events, it is a way to pressure the apiserver's memory and occasionally trip a timeout on a large serialization.

Kubernetes solves this with chunked lists: pass a `Limit`, get back a page of results plus a `continue` token, and pass that token to fetch the next page. kubectl itself does this, defaulting to a chunk size of 500. The catch is that continue tokens expire, typically after about five minutes of inactivity, after which the apiserver returns `410 Gone` with `reason: ResourceExpired` and the message "the continue token provided is too old to display a consistent view."

You do not want to implement token handling and expiry fallback by hand. client-go's `k8s.io/client-go/tools/pager` package does it for you. `ListPager` drives the chunked list, and `EachListItemWithAlloc` streams individual objects to a callback so you never hold a whole page in memory longer than necessary. It also defaults `FullListIfExpired` to true, so an expired token during a long crawl falls back to a full list rather than erroring out.

```go
import (
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/tools/pager"
)

// dumpResource pages through one resource type, writing each object as it arrives.
func dumpResource(
	dynamicClient dynamic.Interface,
	gvr schema.GroupVersionResource,
	namespace, resourceDir string,
) (int, error) {
	lister := dynamicClient.Resource(gvr).Namespace(namespace)

	p := pager.New(func(ctx context.Context, opts metav1.ListOptions) (runtime.Object, error) {
		return lister.List(ctx, opts)
	})
	p.PageSize = 250

	count := 0
	err := p.EachListItemWithAlloc(context.Background(), metav1.ListOptions{},
		func(obj runtime.Object) error {
			u, ok := obj.(*unstructured.Unstructured)
			if !ok {
				return nil
			}
			count++
			return writeObject(resourceDir, u)
		})

	return count, err
}
```

The pager turns a single unbounded request into a stream of bounded ones, which is the difference between a crawler that behaves on a 200-object namespace and one that behaves on a 200,000-object namespace.

## Failure 3: Swallowed 403s

Look again at the naive loop: `if err != nil { continue }`. That line treats every possible List failure identically, and one of those failures is a `403 Forbidden`. When your crawler runs under a ServiceAccount that lacks `list` on some resource, the apiserver says no, the loop swallows it, and the dump completes with exit code 0. You get a directory tree that looks successful and is silently missing every resource the token could not read. For anything audit-shaped or backup-shaped, that is the worst failure mode there is: confident, clean, and wrong.

The fix is to classify errors instead of swallowing them. The `k8s.io/apimachinery/pkg/api/errors` package provides predicates that turn opaque errors into decisions. A `403` means the crawler is under-permissioned and the operator needs to know. A `404` usually means a resource was advertised in discovery but is not actually served, which is benign. A `405 MethodNotAllowed` means the resource genuinely does not support listing in this scope. Everything else is a real error worth surfacing.

```go
import apierrors "k8s.io/apimachinery/pkg/api/errors"

// coverageReport records how the crawl went so the operator can trust the output.
type coverageReport struct {
	dumped    map[string]int // gvr -> object count
	forbidden []string       // gvr strings the token could not list
	skipped   []string       // advertised but not served, or non-listable
	errored   []string       // genuine failures worth investigating
}

func (r *coverageReport) recordListError(gvr schema.GroupVersionResource, err error) {
	switch {
	case apierrors.IsForbidden(err):
		r.forbidden = append(r.forbidden, gvr.String())
	case apierrors.IsNotFound(err):
		r.skipped = append(r.skipped, gvr.String())
	case apierrors.IsMethodNotSupported(err):
		r.skipped = append(r.skipped, gvr.String())
	default:
		r.errored = append(r.errored, fmt.Sprintf("%s: %v", gvr, err))
	}
}

// exitCode makes forbidden resources and hard errors a non-zero exit so a
// CronJob surfaces an incomplete dump instead of reporting success.
func (r *coverageReport) exitCode() int {
	if len(r.forbidden) > 0 || len(r.errored) > 0 {
		return 1
	}
	return 0
}
```

Emitting this report at the end of a run, and exiting non-zero when `forbidden` or `errored` is non-empty, converts a silent gap into a loud, actionable one. A CronJob that fails visibly because it could not read NetworkPolicies is infinitely more useful than one that succeeds while omitting them.

## Failure 4: The Output Won't Reapply

The naive crawler marshals `item.Object` directly, which means every file it writes is stuffed with server-managed fields: `metadata.managedFields`, `resourceVersion`, `uid`, `creationTimestamp`, `generation`, `selfLink`, and a full `status` block. None of that belongs in a manifest you intend to store in Git or reapply to another cluster. `resourceVersion` and `uid` will actively cause `kubectl apply` to reject the object, and `managedFields` alone can triple the size of a file with pure server-side-apply bookkeeping. The tool `kubectl-neat` exists solely to strip these fields, because raw server state "makes manifests non-portable and breaks reapply."

Doing the same in code is a matter of removing the known-noisy fields from the unstructured map before marshaling. `unstructured.RemoveNestedField` walks the nested map safely, doing nothing if a path is absent.

```go
// scrub removes server-managed fields so the output is a clean, reappliable spec.
func scrub(u *unstructured.Unstructured) {
	for _, path := range [][]string{
		{"metadata", "managedFields"},
		{"metadata", "resourceVersion"},
		{"metadata", "uid"},
		{"metadata", "generation"},
		{"metadata", "creationTimestamp"},
		{"metadata", "selfLink"},
		{"metadata", "annotations", "kubectl.kubernetes.io/last-applied-configuration"},
		{"status"},
	} {
		unstructured.RemoveNestedField(u.Object, path...)
	}
}

func writeObject(resourceDir string, u *unstructured.Unstructured) error {
	scrub(u)
	data, err := yaml.Marshal(u.Object)
	if err != nil {
		return fmt.Errorf("marshaling %s: %w", u.GetName(), err)
	}
	path := filepath.Join(resourceDir, u.GetName()+".yaml")
	return os.WriteFile(path, data, 0o644)
}
```

Stripping `status` deserves a caveat. For built-in resources it is always safe, because `status` is a server-owned sub-resource that gets reconstructed on apply. For a few CRDs whose authors folded meaningful configuration into `status` rather than `spec`, removing it discards data. This is rare and arguably a CRD design mistake, but if your crawl covers such a CRD, make the `status` removal opt-out for that specific type rather than blanket. For the overwhelming majority of resources, dropping `status` is exactly right.

## Failure 5: Throttling Against the API Server

client-go rate-limits itself on the client side. By default `rest.Config` sets `QPS: 5` and `Burst: 10`. A crawler issues one List per discovered `GroupVersionResource`, and a real cluster easily reports 100 or more namespaced resource types once operators and CRDs are counted. At 5 queries per second, the crawler spends most of its wall-clock time blocked in the client's own rate limiter, not waiting on the apiserver.

You have two levers. The direct one is to raise `QPS` and `Burst` to values appropriate for a short-lived batch job. The more modern one is to disable client-side rate limiting entirely by setting `QPS` to a negative value, which defers all flow control to server-side API Priority and Fairness (APF). APF has been the default admission-control mechanism for years and is far better positioned to make throttling decisions than a fixed client-side number, because it sees the whole cluster's load rather than one client's guess.

```go
// tuneRateLimits prepares a rest.Config for a batch crawl.
func tuneRateLimits(cfg *rest.Config) {
	// Option A: raise the client-side limits for a batch job.
	cfg.QPS = 50
	cfg.Burst = 100

	// Option B: defer entirely to server-side API Priority and Fairness by
	// setting a negative QPS. Prefer this on clusters where APF is enabled.
	// cfg.QPS = -1
}
```

For a crawler specifically, deferring to APF (Option B) is usually the right call: the workload is bursty and short, and APF will shed load gracefully if the apiserver is already busy rather than letting a fixed client limit either crawl or hammer.

## Putting It Together

Each hardening step above is a self-contained function. Wiring them into a single program shows how they compose: build the clients, tune the rate limits, discover tolerantly, then page through every listable resource while a `coverageReport` accumulates what was captured, what was forbidden, and what genuinely errored.

```go
// runCrawl orchestrates the hardened crawl and returns a coverage report.
func runCrawl(kubeconfig, namespace, outputDir string) (*coverageReport, error) {
	discoveryClient, dynamicClient, err := buildClients(kubeconfig)
	if err != nil {
		return nil, err
	}

	lists, err := discoverTolerant(discoveryClient)
	if err != nil {
		return nil, err
	}

	report := &coverageReport{dumped: map[string]int{}}

	for _, gvr := range listableGVRs(lists) {
		resourceDir := filepath.Join(outputDir, gvr.Resource)
		if err := os.MkdirAll(resourceDir, 0o755); err != nil {
			return nil, fmt.Errorf("creating %s: %w", resourceDir, err)
		}

		count, err := dumpResource(dynamicClient, gvr, namespace, resourceDir)
		if err != nil {
			report.recordListError(gvr, err)
			_ = os.Remove(resourceDir) // nothing was written
			continue
		}
		if count == 0 {
			_ = os.Remove(resourceDir) // prune resources with no instances
			continue
		}
		report.dumped[gvr.Resource] = count
	}

	return report, nil
}

// print writes a sorted, human-readable coverage report to stdout.
func (r *coverageReport) print() {
	types := make([]string, 0, len(r.dumped))
	for t := range r.dumped {
		types = append(types, t)
	}
	sort.Strings(types)

	fmt.Println("captured:")
	for _, t := range types {
		fmt.Printf("  %-24s %d\n", t, r.dumped[t])
	}
	if len(r.forbidden) > 0 {
		sort.Strings(r.forbidden)
		fmt.Printf("forbidden (%d): %v\n", len(r.forbidden), r.forbidden)
	}
	if len(r.errored) > 0 {
		fmt.Printf("errors (%d): %v\n", len(r.errored), r.errored)
	}
}

func main() {
	var kubeconfig, namespace, outputDir string
	defaultKubeconfig := filepath.Join(os.Getenv("HOME"), ".kube", "config")
	flag.StringVar(&kubeconfig, "kubeconfig", defaultKubeconfig, "path to kubeconfig")
	flag.StringVar(&namespace, "namespace", "default", "namespace to crawl")
	flag.StringVar(&outputDir, "output", "k8s-ns-collector-dump", "output directory")
	flag.Parse()

	report, err := runCrawl(kubeconfig, namespace, outputDir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "crawl failed: %v\n", err)
		os.Exit(2)
	}

	report.print()
	os.Exit(report.exitCode()) // non-zero when resources were forbidden or errored
}
```

The `buildClients` helper is the place to apply `tuneRateLimits` to the `rest.Config` before constructing the discovery and dynamic clients, so both share the same flow-control settings.

A run under a correctly scoped ServiceAccount prints a coverage report and exits zero. A run under a token missing a grant prints the same report with a populated `forbidden` list and exits non-zero, which is exactly the signal a scheduled job needs to fail loudly:

```text
captured:
  configmaps                14
  cronjobs                  2
  deployments               6
  ingresses                 3
  jobs                      5
  persistentvolumeclaims    4
  pods                      31
  services                  8
  statefulsets              1
forbidden (1): [networking.k8s.io/v1, Resource=networkpolicies]
```

The `forbidden` line is the difference between a dump you can trust and one you cannot. Without it, the same run would have written a clean-looking tree with no NetworkPolicies and exited zero, and nobody would have known the audit was incomplete.

## RBAC: The Only Enforceable Boundary

The minimal tool excludes Secrets with an in-code denylist, a `map[string]bool` checked before listing. That is a reasonable defense-in-depth measure, but it is not the security control it appears to be, for one structural reason: **Kubernetes RBAC is purely additive and has no deny rules.** If your crawler's ServiceAccount is granted read access to Secrets, nothing in the code denylist changes the fact that the token *can* read them. A refactor that drops the denylist, or a code path that bypasses it, immediately exposes what RBAC already permitted. The enforceable boundary is the RBAC grant, not the Go code.

This creates a genuine tension with the crawler's headline feature. The thing that makes it self-updating is a wildcard read grant: give it `resources: ["*"]` and it can list any CRD installed in the future without a permissions change. But a wildcard over the core group grants read on Secrets, and there is no way to subtract Secrets from a wildcard afterward. You cannot have both "reads every future CRD automatically" and "provably cannot read Secrets" through RBAC alone. You have to choose.

For an audit crawler, the safe choice is an explicit allowlist ClusterRole that names the resources you intend to capture and never grants Secrets. You trade automatic CRD adaptation for a boundary you can prove in a policy review.

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: resource-crawler
rules:
  # Core group enumerated explicitly so "secrets" is never in scope.
  # A wildcard here would grant secrets with no way to subtract it.
  - apiGroups: [""]
    resources:
      - configmaps
      - services
      - pods
      - persistentvolumeclaims
      - serviceaccounts
      - endpoints
    verbs: ["get", "list"]
  - apiGroups: ["apps"]
    resources: ["deployments", "statefulsets", "daemonsets", "replicasets"]
    verbs: ["get", "list"]
  - apiGroups: ["batch"]
    resources: ["jobs", "cronjobs"]
    verbs: ["get", "list"]
  - apiGroups: ["networking.k8s.io"]
    resources: ["ingresses", "networkpolicies"]
    verbs: ["get", "list"]
```

One more caveat that undercuts the "excludes sensitive data" claim regardless of RBAC: Secrets are not the only place credentials live. ConfigMaps routinely carry connection strings, tokens embedded in application config, and cloud credentials that developers put where they were convenient rather than where they were safe. A crawler that captures ConfigMaps, as this one does by design, is capturing sensitive data whether or not it touches Secrets. Treat the output tree as sensitive at rest, encrypt the storage backend, and scope who can read the dumps accordingly.

## Running It as a CronJob

The natural home for a hardened crawler is a scheduled Job that writes to durable storage. Bind the allowlist ClusterRole to a dedicated ServiceAccount, mount a PVC (or configure an S3 sink), and let it run nightly. Set `concurrencyPolicy: Forbid` so a slow run never overlaps the next, and a small `backoffLimit` so a genuinely failing run surfaces rather than retrying forever.

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: resource-crawler
  namespace: cluster-audit
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: resource-crawler
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: resource-crawler
subjects:
  - kind: ServiceAccount
    name: resource-crawler
    namespace: cluster-audit
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: resource-crawler
  namespace: cluster-audit
spec:
  schedule: "0 2 * * *"        # nightly at 02:00
  concurrencyPolicy: Forbid    # never overlap runs
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 2          # surface a failing run instead of retrying forever
      template:
        spec:
          serviceAccountName: resource-crawler
          restartPolicy: Never
          containers:
            - name: crawler
              image: registry.support.tools/resource-crawler:v1.2.0
              args: ["--namespace", "production", "--output", "/data"]
              resources:
                requests:
                  cpu: "100m"
                  memory: "128Mi"
                limits:
                  memory: "512Mi"
              volumeMounts:
                - name: dump
                  mountPath: /data
          volumes:
            - name: dump
              persistentVolumeClaim:
                claimName: resource-crawler-dumps
```

The output of successive runs is diffable. Commit each night's tree to a Git repository and you have a running record of configuration drift across the whole namespace, CRDs included, which is a different and often more useful artifact than a backup: it answers "what changed and when," not just "how is it restored."

## This Is Not a Backup Tool

It is worth stating plainly, because the output looks backup-shaped and the temptation to treat it as one is real. A resource crawler captures the declarative API state of a namespace at a point in time. It does not capture PersistentVolume *data*, it imposes no ordering or referential integrity on restore, it has no notion of hooks or quiescing an application before snapshotting, and it makes no guarantee that reapplying the tree reconstitutes a working system. Those are exactly the problems that dedicated backup tooling solves.

For genuine disaster recovery, reach for a purpose-built tool. This site covers that ground in depth already: see the [Velero backup and restore guides](https://support.tools/tags/velero/) for volume-aware, restore-tested backups, and the [etcd backup and restore guide](https://support.tools/post/rke2-standalone-disaster-recovery/) for cluster-state recovery. A crawler is complementary to those, not a replacement. Its value is as an audit and drift-detection artifact: a diffable, human-readable, CRD-complete snapshot of what the namespace declared, which is precisely the thing Velero backups are not optimized to give you.

## Conclusion

The Discovery API plus the dynamic client is a genuinely powerful pattern, and the minimal 165-line version is a fine way to learn it. Shipping it to production is where the real engineering lives:

- **`kubectl get all` is a shortlist, not a census.** Runtime discovery is the only way to reach CRDs, and it is why this pattern exists.
- **Partial discovery is normal.** Handle `ErrGroupDiscoveryFailed` and proceed with what you got; fail-fast throws away a good dump over one broken aggregated API. `ketall` defaulting `--allow-incomplete` to on is the tell.
- **Never swallow List errors.** Classify with `apierrors.IsForbidden` and friends, emit a coverage report, and exit non-zero on gaps. A silent partial dump is worse than a loud failure.
- **Page large lists** with `client-go/tools/pager` instead of unbounded `List` calls, and stream items to disk rather than buffering pages.
- **Scrub server-managed fields** (`managedFields`, `resourceVersion`, `uid`, `status`) or the output will not reapply.
- **Tune rate limits**, and prefer deferring to API Priority and Fairness with a negative QPS on modern clusters.
- **RBAC is the boundary, not the code.** Because RBAC is additive with no deny, an explicit allowlist ClusterRole is the only provable way to keep Secrets out of scope, and ConfigMaps carry sensitive data regardless.
- **It is not a backup tool.** Use it for audit and drift detection, and use Velero and etcd snapshots for disaster recovery.
