---
title: "Why Kubernetes Needs an LTS"
date: 2024-12-04T12:00:00-05:00
draft: false
tags: ["Kubernetes", "LTS", "Infrastructure", "DevOps"]
categories:
- kubernetes
- Technology
author: "Matthew Mattox - mmattox@support.tools"
description: "Exploring the challenges of Kubernetes' rapid release cycle and the case for introducing a long-term support (LTS) version to aid operational stability."
more_link: "yes"
url: "/kubernetes-lts/"
---

Kubernetes' rapid development cycle has been key to its success, but its aggressive N-2 support policy presents challenges for many organizations. This article explores the case for a long-term support (LTS) release to balance innovation with operational stability.

<!--more-->

---

## Kubernetes' Rapid Pace

Kubernetes follows an **N-2 support policy** with a 15-week release cycle, meaning each release is supported for about 14 months. While this fosters rapid innovation, it creates operational challenges for teams needing to frequently update clusters.

- **Comparison**:
  - Kubernetes: 14-month support window.
  - Debian: Multi-year stability.
  - Cloud providers (AWS, Azure, GCP): Typically offer longer support cycles than Kubernetes' official policy.

---

## The Upgrade Challenge

Upgrading Kubernetes clusters is not a trivial task. The process typically involves:

1. Checking third-party extensions (network/storage plugins).
2. Updating control plane components (etcd, kube-apiserver, controllers, schedulers).
3. Draining and upgrading nodes.
4. Running `kubectl convert` for API manifest changes.
5. Testing and validating across environments.

Even with automation, upgrades demand careful planning, risk management, and downtime mitigation. For many teams, spinning up a new cluster is often easier but still resource-intensive.

---

## Proposed Solution: An LTS Release

A Kubernetes LTS release would provide:

- **24 months of support**: Aligned with many organizations' operational planning cycles.
- **Dead-end upgrades**: No obligation to provide upgrade paths from LTS versions.
- **Cluster lifecycle alignment**: Encouraging teams to rebuild clusters every two years, incorporating OS and hypervisor updates.

### Benefits

1. **Operational simplicity**: Less frequent upgrades, reducing risk and resource demands.
2. **Improved ecosystem stability**: Easier validation for third-party tools and plugins.
3. **Encourages best practices**: Regular cluster refresh cycles enhance security and performance.

---

## The LTS Working Group

The Kubernetes community has revived the LTS working group to explore this concept. While progress has been slow, the potential benefits warrant serious consideration.

### Challenges

- **Maintainer workload**: Supporting LTS alongside the rapid release cycle adds complexity.
- **Ecosystem alignment**: Ensuring compatibility across diverse tools and platforms.

---

## Conclusion

An LTS release could bridge the gap between Kubernetes' rapid innovation and the operational needs of its users. By reducing the frequency of upgrades and encouraging periodic cluster rebuilds, an LTS version would provide stability without stifling progress.

Questions or insights? Connect with me: [LinkedIn](https://www.linkedin.com/in/matthewmattox/), [GitHub](https://github.com/mattmattox), [BlueSky](https://bsky.app/profile/cube8021.bsky.social).
