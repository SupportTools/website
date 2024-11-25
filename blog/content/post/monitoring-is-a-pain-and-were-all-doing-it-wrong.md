---
title: "Monitoring is a Pain (and We're All Doing it Wrong)"
date: 2024-12-19T12:00:00-05:00
draft: false
tags: ["DevOps", "Monitoring", "Observability", "Logs", "Metrics", "Tracing"]
categories:
- DevOps
- Monitoring
author: "Matthew Mattox - mmattox@support.tools"
description: "Exploring why monitoring and observability often feel like a never-ending headache, this article dives into common pitfalls and offers practical suggestions to improve your approach."
more_link: "yes"
url: "/monitoring-is-a-pain-and-were-all-doing-it-wrong/"
---

**And we're all doing it wrong (including me).**

Monitoring is supposed to make life easier for developers and operators, but it often does the opposite. Despite our best intentions, observability tools frequently fall short, leaving us with brittle systems, ballooning costs, and frustration.

<!--more-->

---

## The Problem with Monitoring

Monitoring starts with simplicity: print statements turned into logs, basic metrics, and maybe some traces. But as systems scale, cracks begin to show:
- **Logs**: Endless streams of unstructured data with questionable value.
- **Metrics**: Short-term solutions that don’t scale without significant investment.
- **Tracing**: A promising tool that no one seems to use effectively.

---

## Logs: A Love-Hate Relationship

Logs should provide clarity but often become a source of chaos.

### Common Issues
1. **Log Levels Mean Nothing**  
   Different systems (e.g., Python, Syslog, Golang) define levels inconsistently.
2. **Inconsistent Formats**  
   JSON, Common Event Format, Nginx, and GELF logs all compete with no clear winner.
3. **Logs as a Catch-All Tool**  
   Used for debugging, business intelligence, customer support, and auditing—leading to bloated, brittle systems.

### Suggestions
- **Separate Critical Logs**: Compliance and audit logs shouldn’t live in the same pipeline as 200-OK responses.
- **Set a Realistic SLA**: If logs aren’t critical, enforce an SLA that reflects that reality (e.g., 99% uptime allows for ~7 hours of downtime/month).
- **Use Sampling**: OpenTelemetry supports log sampling—reduce low-priority logs to avoid overloading your system.

---

## Metrics: Simple Until They’re Not

Metrics start simple but often grow out of control.

### Scaling Challenges
1. **Prometheus Limitations**  
   Prometheus isn’t built for high-cardinality, long-term storage, or federated setups.
2. **Business Use Cases**  
   Metrics become critical for everything from customer behavior insights to debugging production issues.

### Solutions
- **Start with Thanos or Cortex**: Avoid re-engineering your system later.  
   - *Thanos*: Modular, simpler setup for long-term storage.
   - *Cortex*: Better for high-volume, high-cardinality environments.
- **Cap Retention Periods**: Define strict retention policies upfront.
- **Control Costs**: Monitor ingestion rates and cardinality to prevent runaway expenses.

---

## Tracing: The Underrated Hero

Tracing bridges the gap between logs and metrics, offering detailed insights into distributed systems. Yet, it remains underutilized.

### Why Tracing Works
- **Sampling**: Built-in sampling reduces data overload.
- **End-to-End Visibility**: Follow requests through load balancers, services, and databases.

### The Challenge
Despite its potential, tracing tools like OpenTelemetry and Cloud Trace often see low adoption among developers.

---

## Practical Suggestions for Better Monitoring

1. **Define Ownership**  
   Assign monitoring to a dedicated team or individual.
2. **Set Realistic Expectations**  
   Monitoring isn’t “set and forget.” Plan for ongoing maintenance.
3. **Separate Use Cases**  
   Logs, metrics, and traces serve different purposes—don’t conflate them.
4. **Invest Early**  
   Start with scalable solutions like Thanos or Cortex to avoid future headaches.

---

## Conclusion

Monitoring is essential but often treated as an afterthought. By acknowledging its challenges and investing in better tools and practices, we can build systems that work for us—not against us.
