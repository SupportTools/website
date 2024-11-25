---
title: "Adventures in IPv6 Part 2"
date: 2024-12-08T12:00:00-05:00
draft: false
tags: ["IPv6", "Networking", "Docker", "GhostCMS", "DevOps"]
categories:
- networking
- Technology
author: "Matthew Mattox - mmattox@support.tools"
description: "A continuation of my journey into IPv6-only infrastructure, diving into mail configurations, Docker challenges, and resolving compatibility issues with popular tools."
more_link: "yes"
url: "/ipv6-adventures-part-2/"
---

As the world inches toward IPv6, my quest to run this blog on IPv6-only infrastructure continues. While progress has been made, challenges abound—from SMTP configurations to Nodemailer quirks and Docker networking.

<!--more-->

---

## SMTP and Mail Challenges

Switching from Mailgun to Scaleway resolved one major IPv6 hurdle, but getting Ghost CMS to play nicely with IPv6-only SMTP servers revealed deep compatibility gaps in the tooling ecosystem.

### Findings:
1. **Scaleway Compatibility**:
   - Successfully connected to Scaleway's SMTP over IPv6 (`smtp.tem.scw.cloud`).
   - Verified connectivity with `telnet` and ICMP tests.

2. **Nodemailer and Ghost CMS**:
   - Nodemailer struggles with IPv6:
     - Error: `connect ENETUNREACH`.
     - Workaround: Manually set the IPv6 address and hostname in the transport configuration.
   - Submitted a fix for Ghost CMS to address this.

---

## Docker Networking for IPv6

Docker networking posed its own set of challenges:
1. **IPv6 Container Communication**:
   - Docker's default bridge failed for IPv6-only networks.
   - Solution: Create a user-defined network with IPv6 configuration.

2. **Image Pulls**:
   - Required using `registry.ipv6.docker.com` for pulling images.

---

## Resolving Python Issues

The pre-installed Python on my system created unexpected headaches:
- **Pip Problems**:
  - Encountered PEP 668-related restrictions.
  - Solution: Compiled Python 3.11.4 from source and used `venv`.

- **Scripts**:
  - Successfully tested custom scripts using the `requests` library, which handled IPv6 seamlessly.

---

## Conclusion

Running an IPv6-only server is an ongoing challenge. From mail and Docker configurations to Node.js and Python quirks, compatibility issues abound. While solutions exist, they require significant troubleshooting and patchwork.

IPv6 adoption is growing, but this experiment underscores the need for broader, more robust support in popular tooling. If you're venturing into IPv6-only infrastructure, be prepared for a time-intensive process.

Thoughts or feedback? Connect with me: [LinkedIn](https://www.linkedin.com/in/matthewmattox/), [GitHub](https://github.com/mattmattox), [BlueSky](https://bsky.app/profile/cube8021.bsky.social).
