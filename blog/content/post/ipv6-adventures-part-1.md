---
title: "IPv6 Is A Disaster (but we can fix it)"
date: 2024-12-04T12:00:00-05:00
draft: false
tags: ["IPv6", "Networking", "DevOps", "Infrastructure"]
categories:
- networking
- Technology
author: "Matthew Mattox - mmattox@support.tools"
description: "Exploring the challenges of migrating to IPv6 and the necessary steps to fix the broken state of IPv6 adoption in the modern internet."
more_link: "yes"
url: "/ipv6-adventures-part-1/"
---

With IPv4 costs rising and availability shrinking, the shift to IPv6 seems inevitable. But as this blog reveals, transitioning to IPv6 is fraught with challenges and broken dependencies. Here's an exploration of what works, what doesn't, and how to bridge the gap.

<!--more-->

---

## The Push for IPv6

The migration to IPv6 has been a slow burn, but cloud providers charging for IPv4 addresses is accelerating the shift. Despite IPv6's advantages—address space, faster routing, and auto-addressing—adoption remains patchy.

---

## Setting Up IPv6-Only: The Pain Points

### 1. **Address Assignment**
- Received a /64 block (18 quintillion addresses), which felt excessive but aligns with IPv6 standards.
- **Pro Tip**: Avoid optimizing address utilization—embrace the /64 prefix.

### 2. **Basic Functionality Breakdowns**
- **SSH Access**: Home/work ISPs don’t support IPv6. Needed a Cloudflare tunnel with `--edge-ip-version 6`.
- **GitHub Access**: GitHub doesn't support IPv6 natively, requiring a proxy workaround.
- **Datadog Setup**: Failed due to IPv6 dependency gaps, requiring NAT64 for functionality.

### 3. **The NAT64 Band-Aid**
- **Solution**: Used [Kasper Dupont's NAT64](https://nat64.net/) service to bridge IPv6 to IPv4 resources.
- **Challenge**: Reliance on community-run services for essential functionality.

---

## Practical Adjustments for IPv6

- **Docker**: Requires `registry.ipv6.docker.com` prefix for image pulls.
- **SSL with Cloudflare**: Switched to authenticated origin pulls for improved security.
- **Unsolved Issues**:
  - Containers communicating with IPv4.
  - Lack of IPv6-compatible SMTP providers.

---

## Why Push for IPv6?

Beyond addressing shortages, IPv6 simplifies network design:
- Removes reliance on NATs, load balancers, and private VPCs for basic routing.
- Encourages direct internet exposure with improved security practices.
- Supports long-term organizational control over IP allocation.

---

## Conclusion

The road to IPv6 adoption is rocky, marked by broken dependencies and limited support. However, the shift offers a chance to rethink network design and reduce reliance on costly IPv4 addresses.

### Is IPv6 ready for production?

Not quite. Organizations need to prepare for workarounds and allocate time to address compatibility issues.

Thoughts or feedback? Connect with me: [LinkedIn](https://www.linkedin.com/in/matthewmattox/), [GitHub](https://github.com/mattmattox), [BlueSky](https://bsky.app/profile/cube8021.bsky.social).
