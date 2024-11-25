---
title: "The Time Linkerd Erased My Load Balancer"
date: 2025-08-10T12:00:00-05:00
draft: false
tags: ["Kubernetes", "Gateway API", "Linkerd", "CRD Conflicts", "GKE"]
categories:
- Kubernetes
- DevOps
- Cloud
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep dive into how CRD conflicts between Linkerd and Gateway API caused a catastrophic load balancer failure in GKE."
more_link: "yes"
url: "/linkerd-erased-load-balancer/"
---

Kubernetes is an incredibly flexible system, but that flexibility sometimes comes with pitfalls. This is the story of how a CRD conflict between Linkerd and the Gateway API in GKE led to an unexpected and dramatic production outage. Hopefully, by sharing my experiences, I can help others avoid a similar fate.

<!--more-->

---

## Background: Ingress vs. Gateway API

For those unfamiliar, **Ingress** has long been the standard way to configure load balancers in Kubernetes. **Gateway API**, a newer approach, redefines how traffic routing and load balancing are handled, allowing for better separation of concerns and more granular control.

My migration plan was straightforward:

1. Enable Gateway API alongside Ingress.
2. Test Gateway API in low-traffic environments.
3. Gradually transition production traffic to Gateway API.

Everything worked fine in staging. But as I moved to production, things took a turn.

---

## The First Blow-Up: Gateway API + Linkerd Memory Issues

When I transitioned production traffic to Gateway API, **Linkerd-proxy sidecar containers** began consuming unbounded memory, eventually triggering OOM kills. My low-traffic tests hadn't revealed this behavior. Cutting back to Ingress resulted in unexpected issues:

- **Mismatch in Annotations**:  
   Gateway API and Ingress annotations conflicted, preventing a seamless rollback.

- **GKE Error**:  
   My rollback failed with:  
   `"Translation failed: invalid ingress spec: service 'my_namespace/my_service' is type 'ClusterIP', expected 'NodePort' or 'LoadBalancer'"`

I spent hours manually modifying annotations to restore traffic.

---

## The Second Blow-Up: Removing Linkerd CRDs

Frustrated with Linkerd's behavior, I decided to start fresh by removing the Linkerd CRDs. That’s when things got really interesting. Upon removing the CRDs:

- **All HTTPRoutes Disappeared**:  
   The load balancer routes tied to Gateway API were suddenly gone.  
   Traffic in my non-prod environment dropped to zero.

### The Culprit: Linkerd’s Gateway API CRD Conflict

Linkerd’s Helm chart defaults to enabling its own HTTPRoute CRDs, which conflicted with GKE's Gateway API implementation. When I removed Linkerd, the Gateway API CRDs were also removed—because they were Linkerd's version, not GKE's.

---

## What Are CRDs?

**Custom Resource Definitions (CRDs)** extend Kubernetes to manage domain-specific resources. In this case:

- **GKE Gateway API CRDs**: Managed by GCP, enabling Gateway API functionality.
- **Linkerd Gateway API CRDs**: Installed by Linkerd Helm charts for experimental support.

The conflict arose because GKE and Linkerd both defined HTTPRoute CRDs. Linkerd's version silently replaced GKE's during installation.

---

## Lessons Learned

1. **Always Audit Helm Charts**:  
   Before deploying Helm charts, review values and CRDs they introduce. Linkerd’s `enableHttpRoutes` should have been set to `false`.

2. **CRD Management Is Tricky**:  
   Removing CRDs can have unintended consequences. Always double-check dependencies.

3. **Staging ≠ Production**:  
   High-traffic environments can expose hidden issues. Plan migrations with rollback options.

4. **Use Observability Tools**:  
   Debugging Linkerd’s memory issues was complicated without sufficient logging and metrics.

---

## Conclusion

If you’re using Linkerd and planning to adopt Gateway API, disable Linkerd’s HTTPRoute CRDs. Learn from my mistakes and avoid the chaos of losing load balancer routes in production.
