---
title: "Redis Is Open Source Again. But Is It Too Late?"
date: 2025-05-19T00:00:00-05:00
draft: false
tags: ["Redis", "Open Source", "Valkey", "Database", "In-Memory Database", "NoSQL", "Vector Database", "License", "AGPLv3", "BSD"]
categories:
- Redis
- Open Source
- Databases
author: "Matthew Mattox - mmattox@support.tools"
description: "Redis 8 returns to open source with AGPLv3 and introduces vector search capabilities. But after community migration to Valkey and trust erosion, we analyze if the move comes too late."
more_link: "yes"
url: "/redis-open-source-again/"
---

Redis 8 just landed—and with it, a stunning twist in the open source world. After a controversial license change in 2024 that sparked community uproar and gave rise to forks like Valkey, Redis is back under an OSI-approved license: **AGPLv3**.

But the timing raises an uncomfortable question: *Is it too late?*

<!--more-->

# [Redis Is Open Source Again. But Is It Too Late?](#redis-is-open-source-again-but-is-it-too-late)

{{< figure src="https://cdn.support.tools/posts/redis-open-source-again/redis-open-source-again.png" alt="Redis vs Valkey comparison" caption="Redis returns to open source with version 8, competing with the community-backed Valkey fork" >}}

## How Did We Get Here?

In early 2024, Redis moved away from the permissive BSD license to a dual-license model: **RSALv2** and **SSPLv1**. This was a defensive move—an attempt to prevent cloud giants from profiting off Redis without contributing back.

The result? Mixed.

- Microsoft signed commercial terms.
- Amazon and Google didn't. Instead, they backed **Valkey**, a community-driven fork under the **Linux Foundation**, based on Redis 7.2.4.
- Popular distros like Arch Linux dropped Redis entirely in favor of Valkey.

The decision triggered a community rift. Developers weren’t just unhappy—they felt blindsided. And in open source, trust is everything.

## Salvatore’s Return and the Redis 8 Pivot

Enter **Salvatore Sanfilippo**, the original creator of Redis. His return marked a philosophical reboot for the project. Redis 8 isn’t just a technical update—it’s a cultural shift.

Redis 8 introduces:

- **Vector sets**, a data type designed for AI/ML workloads with native similarity search capabilities
- Native support for **JSON**, **time series**, and **probabilistic** data types (formerly Redis Stack)
- Enhanced **multi-threading** improvements for better CPU utilization
- Improved **memory efficiency** with optimized data structures
- A **relicense to AGPLv3**, making Redis fully open source again

AGPLv3 is stricter than BSD, especially around SaaS usage, but it's officially open source and OSI-approved. It’s a meaningful signal: Redis wants to earn back goodwill.

## But Here’s the Problem

The community already moved on.

- Dockerfiles, Helm charts, and CI pipelines now use **Valkey**
- Some developers are **contributing to Valkey** instead of Redis
- Redis Ltd. is still listing **RSALv2, SSPLv1, and AGPLv3** as options—raising fears that AGPLv3 might be temporary

When Redis changed licenses last year, contributors were caught off guard. Now they’re wary. One developer summarized the mood:  
> “Trust is built over years and lost in a moment.”

Even with Redis 8’s advancements, regaining that trust won’t be easy.

## Redis 8 vs. Valkey: Technical Comparison

Before deciding whether to switch back, let's examine how these implementations compare:

| Feature | Redis 8 | Valkey (based on Redis 7.2.4) |
|---------|---------|-------------------------------|
| **Performance** | Enhanced with multi-threading | Working on multi-threaded I/O |
| **Vector operations** | Native vector sets | Requires modules |
| **JSON support** | Native | Requires RedisJSON module |
| **License** | AGPLv3 | BSD |
| **Community governance** | Redis Ltd. controlled | Linux Foundation, open governance |
| **Cloud provider support** | Microsoft | AWS, Google Cloud |

## Should You Switch Back?

- **Already on Valkey?** No rush. Valkey's roadmap looks solid—multi-threaded I/O, community governance, and wide adoption.
- **Starting fresh?** Redis 8 is now a legitimate, open source contender again—with better defaults and new features.
- **Evaluating long-term strategy?** Weigh the technical advantages against the potential risk of future licensing pivots.

Right now, Redis 8 is technically impressive—but emotionally, the community still feels burned.

## Practical Example: Vector Sets for AI Workloads

One of Redis 8's standout features is native vector sets. Here's a simple example showing how to create and query a vector set:

```redis
# Create a vector set with 3 dimensions
FT.CREATE myindex SCHEMA vec VECTOR FLAT 3 TYPE FLOAT32 DIM 128 DISTANCE_METRIC COSINE

# Add vectors (simplified example)
HSET item:1 vec "[0.1, 0.2, 0.3, ...]" description "First item"
HSET item:2 vec "[0.2, 0.3, 0.4, ...]" description "Second item"

# Perform a vector similarity search
FT.SEARCH myindex "*=>[KNN 5 @vec $query_vector]" PARAMS 2 query_vector "[0.15, 0.25, 0.35, ...]"
```

This capability, now native to Redis, makes it particularly attractive for AI applications like recommendation systems, semantic search, and image recognition.

## Final Thoughts

There’s something poetic about Redis trying to make things right. Salvatore’s return, Redis 8’s features, and the AGPLv3 license all signal an attempt to realign with the developer world it once inspired.

But make no mistake: this isn’t just a version bump—it’s a reputational rebuild.

Redis is open source again. Now it must prove it means to stay that way.
