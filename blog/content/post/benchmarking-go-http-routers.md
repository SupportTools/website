---
title: "Benchmarking Go HTTP Routers: Performance Comparison and Analysis"
date: 2025-09-23T09:00:00-05:00
draft: false
tags: ["Go", "HTTP", "Performance", "Routers", "Benchmarks", "Web Development", "Microservices"]
categories:
- Go
- Performance
- Web Development
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive performance analysis of popular Go HTTP routers including httprouter, gin, chi, echo and more, with detailed benchmark results and architectural insights"
more_link: "yes"
url: "/benchmarking-go-http-routers/"
---

When building web applications or APIs in Go, choosing the right HTTP router can significantly impact performance, especially at scale. This article analyzes and compares the performance characteristics of popular Go HTTP routers to help you make an informed choice for your next project.

<!--more-->

# [Introduction](#introduction)

The HTTP router is a critical component in any web application, responsible for matching incoming requests to the appropriate handlers. In Go's ecosystem, developers have numerous router options ranging from the standard library's `http.ServeMux` to feature-rich third-party packages.

While functionality and developer experience are important factors when selecting a router, performance characteristics become increasingly critical as applications scale. This is particularly true for high-traffic services or resource-constrained environments.

This article presents benchmark results comparing 16 popular Go HTTP routers, analyzing their performance across different routing scenarios.

## [Routers Examined](#routers-examined)

Our benchmarks include the following HTTP routers:

1. **Standard Library**: `net/http.ServeMux` - Go's built-in HTTP router
2. **[github.com/bmf-san/goblin](https://github.com/bmf-san/goblin)** - A simple trie-based HTTP router
3. **[github.com/julienschmidt/httprouter](https://github.com/julienschmidt/httprouter)** - A popular high-performance router based on a radix tree
4. **[github.com/go-chi/chi](https://github.com/go-chi/chi)** - A lightweight, composable router with middleware support
5. **[github.com/gin-gonic/gin](https://github.com/gin-gonic/gin)** - A full-featured web framework with a router at its core
6. **[github.com/uptrace/bunrouter](https://github.com/uptrace/bunrouter)** - A fast and flexible HTTP router
7. **[github.com/dimfeld/httptreemux](https://github.com/dimfeld/httptreemux)** - An adaptation of httprouter with more flexible parameter handling
8. **[github.com/beego/mux](https://github.com/beego/mux)** - The router component from the Beego framework
9. **[github.com/gorilla/mux](https://github.com/gorilla/mux)** - A powerful URL router and dispatcher with extensive pattern matching
10. **[github.com/nissy/bon](https://github.com/nissy/bon)** - A lightweight, fast HTTP router
11. **[github.com/naoina/denco](https://github.com/naoina/denco)** - An HTTP router that uses a double-array trie
12. **[github.com/labstack/echo](https://github.com/labstack/echo)** - A high-performance, minimalist framework
13. **[github.com/gocraft/web](https://github.com/gocraft/web)** - A router focused on middleware and context
14. **[github.com/vardius/gorouter](https://github.com/vardius/gorouter)** - A CORS-supporting HTTP router
15. **[github.com/go-ozzo/ozzo-routing](https://github.com/go-ozzo/ozzo-routing)** - A fast routing engine from the Ozzo framework
16. **[github.com/lkeix/techbook13-sample](https://github.com/lkeix/techbook13-sample)** - A sample router implementation

# [Benchmark Methodology](#methodology)

## [Test Environment](#test-environment)

All benchmarks were run on the following environment:

- **Go Version**: 1.19
- **Operating System**: Darwin (macOS)
- **Architecture**: amd64
- **CPU**: VirtualApple @ 2.50GHz

## [Test Cases](#test-cases)

Our benchmarks focus on two primary routing scenarios:

1. **Static Routes**: Fixed URL paths without variables
2. **Path Parameter Routes**: URLs containing path parameters (e.g., `/user/:id`)

### Static Routes Tests

For static routes, we tested four different path patterns:

- **Root**: `/`
- **Simple**: `/foo`
- **Medium**: `/foo/bar/baz/qux/quux`
- **Long**: `/foo/bar/baz/qux/quux/corge/grault/garply/waldo/fred`

These tests evaluate how routers handle paths of increasing length and complexity.

### Path Parameter Tests

For routes with path parameters, we tested three patterns with increasing numbers of parameters:

- **Single parameter**: `/foo/:bar`
- **Five parameters**: `/foo/:bar/:baz/:qux/:quux/:corge`
- **Ten parameters**: `/foo/:bar/:baz/:qux/:quux/:corge/:grault/:garply/:waldo/:fred/:plugh`

Since router implementations may use different syntax for path parameters (e.g., `:param`, `{param}`, or `<param>`), the tests account for these differences.

## [Metrics Measured](#metrics)

For each test case, we measured four key performance metrics:

1. **Execution Count (`time`)**: Number of function executions completed during the benchmark period. Higher is better.
2. **Time per Operation (`ns/op`)**: Average time in nanoseconds required per function execution. Lower is better.
3. **Memory Allocation (`B/op`)**: Average memory allocated in bytes per operation. Lower is better.
4. **Allocation Count (`allocs/op`)**: Average number of heap allocations per operation. Lower is better.

# [Benchmark Results](#results)

## [Static Routes Results](#static-results)

### Execution Count (time)

| Router | Root Path | Simple Path | Medium Path | Long Path |
|--------|-----------|-------------|-------------|-----------|
| servemux | 24,301,910 | 22,053,468 | 13,324,357 | 8,851,803 |
| goblin | 32,296,879 | 16,738,813 | 5,753,088 | 3,111,172 |
| httprouter | 100,000,000 | 100,000,000 | 100,000,000 | 72,498,970 |
| chi | 5,396,652 | 5,350,285 | 5,353,856 | 5,415,325 |
| gin | 34,933,861 | 34,088,810 | 34,136,852 | 33,966,028 |
| bunrouter | 63,478,486 | 54,812,665 | 53,564,055 | 54,345,159 |
| httptreemux | 6,669,231 | 6,219,157 | 5,278,312 | 4,300,488 |
| beegomux | 22,320,199 | 15,369,320 | 1,000,000 | 577,272 |
| gorillamux | 1,807,042 | 2,104,210 | 1,904,696 | 1,869,037 |
| bon | 72,425,132 | 56,830,177 | 59,573,305 | 58,364,338 |
| denco | 90,249,313 | 92,561,344 | 89,325,312 | 73,905,086 |
| echo | 41,742,093 | 36,207,878 | 23,962,478 | 12,379,764 |
| gocraftweb | 1,284,613 | 1,262,863 | 1,000,000 | 889,360 |
| gorouter | 21,622,920 | 28,592,134 | 15,582,778 | 9,636,147 |
| ozzorouting | 31,406,931 | 34,989,970 | 24,825,552 | 19,431,296 |
| techbook13-sample | 8,176,849 | 6,349,896 | 2,684,418 | 1,384,840 |

### Time per Operation (ns/op)

| Router | Root Path | Simple Path | Medium Path | Long Path |
|--------|-----------|-------------|-------------|-----------|
| servemux | 50.44 | 54.97 | 89.81 | 135.2 |
| goblin | 36.63 | 69.9 | 205.2 | 382.7 |
| httprouter | 10.65 | 10.74 | 10.75 | 16.42 |
| chi | 217.2 | 220.1 | 216.7 | 221.5 |
| gin | 34.53 | 34.91 | 34.69 | 35.04 |
| bunrouter | 18.77 | 21.78 | 22.41 | 22.0 |
| httptreemux | 178.8 | 190.9 | 227.2 | 277.7 |
| beegomux | 55.07 | 74.69 | 1080 | 2046 |
| gorillamux | 595.7 | 572.8 | 626.5 | 643.3 |
| bon | 15.75 | 20.17 | 18.87 | 19.16 |
| denco | 14.0 | 13.03 | 13.4 | 15.87 |
| echo | 28.17 | 32.83 | 49.82 | 96.77 |
| gocraftweb | 929.4 | 948.8 | 1078 | 1215 |
| gorouter | 55.16 | 37.64 | 76.6 | 124.1 |
| ozzorouting | 42.62 | 34.22 | 48.12 | 61.6 |
| techbook13-sample | 146.1 | 188.4 | 443.5 | 867.8 |

### Memory Allocation (B/op)

| Router | Root Path | Simple Path | Medium Path | Long Path |
|--------|-----------|-------------|-------------|-----------|
| servemux | 0 | 0 | 0 | 0 |
| goblin | 0 | 16 | 80 | 160 |
| httprouter | 0 | 0 | 0 | 0 |
| chi | 304 | 304 | 304 | 304 |
| gin | 0 | 0 | 0 | 0 |
| bunrouter | 0 | 0 | 0 | 0 |
| httptreemux | 328 | 328 | 328 | 328 |
| beegomux | 32 | 32 | 32 | 32 |
| gorillamux | 720 | 720 | 720 | 720 |
| bon | 0 | 0 | 0 | 0 |
| denco | 0 | 0 | 0 | 0 |
| echo | 0 | 0 | 0 | 0 |
| gocraftweb | 288 | 288 | 352 | 432 |
| gorouter | 0 | 0 | 0 | 0 |
| ozzorouting | 0 | 0 | 0 | 0 |
| techbook13-sample | 304 | 308 | 432 | 872 |

### Allocation Count (allocs/op)

| Router | Root Path | Simple Path | Medium Path | Long Path |
|--------|-----------|-------------|-------------|-----------|
| servemux | 0 | 0 | 0 | 0 |
| goblin | 0 | 1 | 1 | 1 |
| httprouter | 0 | 0 | 0 | 0 |
| chi | 2 | 2 | 2 | 2 |
| gin | 0 | 0 | 0 | 0 |
| bunrouter | 0 | 0 | 0 | 0 |
| httptreemux | 3 | 3 | 3 | 3 |
| beegomux | 1 | 1 | 1 | 1 |
| gorillamux | 7 | 7 | 7 | 7 |
| bon | 0 | 0 | 0 | 0 |
| denco | 0 | 0 | 0 | 0 |
| echo | 0 | 0 | 0 | 0 |
| gocraftweb | 6 | 6 | 6 | 6 |
| gorouter | 0 | 0 | 0 | 0 |
| ozzorouting | 0 | 0 | 0 | 0 |
| techbook13-sample | 2 | 3 | 11 | 21 |

## [Path Parameter Routes Results](#param-results)

### Execution Count (time)

| Router | 1 Parameter | 5 Parameters | 10 Parameters |
|--------|-------------|--------------|---------------|
| goblin | 1,802,690 | 492,392 | 252,274 |
| httprouter | 25,775,940 | 10,057,874 | 6,060,843 |
| chi | 4,337,922 | 2,687,157 | 1,772,881 |
| gin | 29,479,381 | 15,714,673 | 9,586,220 |
| bunrouter | 37,098,772 | 8,479,642 | 3,747,968 |
| httptreemux | 2,610,324 | 1,550,306 | 706,356 |
| beegomux | 3,177,818 | 797,472 | 343,969 |
| gorillamux | 1,364,386 | 470,180 | 223,627 |
| bon | 6,639,216 | 4,486,780 | 3,285,571 |
| denco | 20,093,167 | 8,503,317 | 4,988,640 |
| echo | 30,667,137 | 12,028,713 | 6,721,176 |
| gocraftweb | 921,375 | 734,821 | 466,641 |
| gorouter | 4,678,617 | 3,038,450 | 2,136,946 |
| ozzorouting | 27,126,000 | 12,228,037 | 7,923,040 |
| techbook13-sample | 3,019,774 | 917,042 | 522,897 |

### Time per Operation (ns/op)

| Router | 1 Parameter | 5 Parameters | 10 Parameters |
|--------|-------------|--------------|---------------|
| goblin | 652.4 | 2,341 | 4,504 |
| httprouter | 45.73 | 117.4 | 204.2 |
| chi | 276.4 | 442.8 | 677.6 |
| gin | 40.21 | 76.39 | 124.3 |
| bunrouter | 32.52 | 141.1 | 317.2 |
| httptreemux | 399.7 | 778.5 | 1,518 |
| beegomux | 377.2 | 1,446 | 3,398 |
| gorillamux | 850.3 | 2,423 | 5,264 |
| bon | 186.5 | 269.6 | 364.4 |
| denco | 60.47 | 139.4 | 238.7 |
| echo | 39.36 | 99.6 | 175.7 |
| gocraftweb | 1,181 | 1,540 | 2,280 |
| gorouter | 256.4 | 393 | 557.6 |
| ozzorouting | 43.66 | 99.52 | 150.4 |
| techbook13-sample | 380.7 | 1,154 | 2,150 |

### Memory Allocation (B/op)

| Router | 1 Parameter | 5 Parameters | 10 Parameters |
|--------|-------------|--------------|---------------|
| goblin | 409 | 962 | 1,608 |
| httprouter | 32 | 160 | 320 |
| chi | 304 | 304 | 304 |
| gin | 0 | 0 | 0 |
| bunrouter | 0 | 0 | 0 |
| httptreemux | 680 | 904 | 1,742 |
| beegomux | 672 | 672 | 1,254 |
| gorillamux | 1,024 | 1,088 | 1,751 |
| bon | 304 | 304 | 304 |
| denco | 32 | 160 | 320 |
| echo | 0 | 0 | 0 |
| gocraftweb | 656 | 944 | 1,862 |
| gorouter | 360 | 488 | 648 |
| ozzorouting | 0 | 0 | 0 |
| techbook13-sample | 432 | 968 | 1,792 |

### Allocation Count (allocs/op)

| Router | 1 Parameter | 5 Parameters | 10 Parameters |
|--------|-------------|--------------|---------------|
| goblin | 6 | 13 | 19 |
| httprouter | 1 | 1 | 1 |
| chi | 2 | 2 | 2 |
| gin | 0 | 0 | 0 |
| bunrouter | 0 | 0 | 0 |
| httptreemux | 6 | 9 | 11 |
| beegomux | 5 | 5 | 6 |
| gorillamux | 8 | 8 | 9 |
| bon | 2 | 2 | 2 |
| denco | 1 | 1 | 1 |
| echo | 0 | 0 | 0 |
| gocraftweb | 9 | 12 | 14 |
| gorouter | 4 | 4 | 4 |
| ozzorouting | 0 | 0 | 0 |
| techbook13-sample | 10 | 33 | 59 |

# [Analysis and Insights](#analysis)

## [Static Routes Performance](#static-analysis)

For static routes, several routers showed exceptional performance:

1. **httprouter** consistently delivers the best performance across all path lengths. Its execution count is significantly higher than other routers, and its time per operation is the lowest.

2. **denco** and **bon** also demonstrate excellent performance characteristics, often within 1.5-2x of httprouter's speed.

3. **gin** and **bunrouter** form the next performance tier, delivering solid results and maintaining consistent performance as path complexity increases.

4. **gorillamux** and **gocraftweb** show the least favorable performance for static routes, with the highest time per operation and lowest execution counts.

An interesting observation is how some routers (like **beegomux**) show significant performance degradation as path length increases, while others (like **httprouter**, **gin**, and **bunrouter**) maintain consistent performance regardless of path complexity.

## [Path Parameter Performance](#param-analysis)

When handling routes with path parameters, the performance landscape changes:

1. **bunrouter**, **gin**, and **echo** show excellent performance for single parameter routes, but their performance decreases as parameter count increases.

2. **httprouter** maintains a strong balance of performance across all parameter counts, showing good scalability.

3. **denco** and **ozzorouting** also perform well across the parameter count spectrum.

4. **gorillamux** and **goblin** show the most significant performance degradation as parameter count increases.

In most routers, there's a clear inverse relationship between the number of path parameters and performance. This correlation is expected, as more parameters require more string parsing, variable extraction, and context storing.

## [Memory Efficiency](#memory-analysis)

Memory efficiency is particularly important in high-throughput applications where router operations occur thousands of times per second:

1. **gin**, **bunrouter**, **echo**, and **ozzorouting** stand out by achieving zero allocations per operation in all test cases, indicating highly optimized memory usage.

2. **httprouter** and **denco** show minimal allocations only for path parameter routes, but none for static routes.

3. **gorillamux** consistently shows the highest memory allocation and allocation count across all tests, which may impact performance in memory-constrained environments.

The correlation between low memory allocation and high performance is evident in the results, with the best-performing routers generally having fewer allocations.

## [Data Structure Impact](#data-structure-impact)

The internal data structures used by these routers significantly influence their performance:

1. **Radix Tree (Patricia Trie)**: Used by httprouter, gin, echo, chi, and bon. This structure optimizes path matching by sharing common prefixes, resulting in efficient memory usage and fast lookups. The strong performance of these routers demonstrates the effectiveness of this data structure for HTTP routing.

2. **Double Array Trie**: Implemented by denco, offering compact storage and fast lookups, particularly beneficial for static routes.

3. **Standard Trie**: Used by goblin, which shows reasonable performance for simple cases but degrades with complexity.

4. **Linear Matching**: Used by the standard library's ServeMux, which is surprisingly competitive for simple static routes but lacks support for path parameters.

5. **RegExp-based Matching**: Some routers use regular expressions for complex patterns, which typically shows poorer performance characteristics.

# [Choosing the Right Router for Your Application](#choosing)

Based on the benchmark results, here are recommendations for different application scenarios:

## [High-Performance APIs](#high-performance-apis)

For applications where raw routing performance is critical:

1. **httprouter** offers the best overall performance across both static and parameter-based routes
2. **gin** provides excellent performance with additional features and zero memory allocations
3. **bunrouter** is a strong contender, especially for applications with fewer path parameters

## [Feature-Rich Applications](#feature-rich)

If you need more functionality beyond basic routing:

1. **echo** balances good performance with a comprehensive feature set
2. **chi** offers a middleware-focused approach with reasonable performance
3. **gin** combines high performance with extensive feature set

## [Memory-Constrained Environments](#memory-constrained)

For applications running in environments with limited memory:

1. **bunrouter**, **gin**, and **echo** stand out with zero allocations
2. **httprouter** and **denco** are also excellent choices with minimal allocations
3. Avoid **gorillamux** and **gocraftweb** which have higher memory footprints

## [Simple Applications](#simple-apps)

For simpler applications with basic routing needs:

1. The standard library's **ServeMux** performs surprisingly well for static routes
2. **goblin** provides a lightweight alternative with path parameter support
3. **bon** offers good performance with minimal features

# [Performance Optimization Strategies](#optimization)

If you're implementing your own HTTP router or optimizing an existing application, consider these strategies from the best-performing routers:

1. **Efficient Data Structures**: Utilize specialized tree structures like radix trees or double-array tries that optimize for common prefixes in URL paths.

2. **Minimize Allocations**: Reduce or eliminate memory allocations in the hot path. Pre-allocate data structures where possible and reuse them across requests.

3. **Avoid Regular Expressions**: While flexible, regex-based matching tends to be slower than specialized path matching algorithms.

4. **Use Fixed-Size Data Structures**: When parameters are known in advance, use fixed-size arrays instead of dynamic slices to avoid allocations.

5. **Path Normalization**: Handle path normalization (like trailing slashes or multiple slashes) during route registration rather than at request time.

6. **Parameter Extraction Optimization**: Extract path parameters efficiently, preferably without string allocations.

# [Conclusion](#conclusion)

The performance characteristics of HTTP routers in Go vary significantly, with trade-offs between speed, memory efficiency, and features. The benchmarks reveal that:

1. The best-performing routers leverage optimized data structures like radix trees or double-array tries.
2. Performance tends to correlate inversely with memory allocations.
3. There's often a trade-off between feature richness and raw performance.
4. Some routers maintain consistent performance across different routing scenarios, while others show significant degradation as complexity increases.

While these benchmarks provide valuable insights, it's important to remember that router performance is just one aspect of overall application performance. In practice, database queries, business logic, and external service calls typically dominate the request processing time.

For most applications, selecting a router with good developer ergonomics that meets your feature requirements will likely be more beneficial than choosing solely based on benchmark results. However, for high-volume services where router performance could become a bottleneck, these benchmarks offer valuable guidance.

Remember that the best router for your application depends on your specific requirements, including performance needs, feature requirements, and development preferences.

# [References](#references)

- [Go Router Benchmark Repository](https://github.com/bmf-san/go-router-benchmark)
- [Go HTTP Router Implementations](https://github.com/avelino/awesome-go#routers)
- [Radix Tree Implementation](https://en.wikipedia.org/wiki/Radix_tree)
- [Double-Array Trie](https://linux.thai.net/~thep/datrie/datrie.html)
- [Go Benchmark Testing Documentation](https://pkg.go.dev/testing#hdr-Benchmarks)