# Near-duplicate clusters: keepers and retirements (2026-10-26)

Item 5 of `2026-10-26-gsc-index-quality-backlog.md` (and the duplicate-title part of item 4).

## How the keeper was picked

- **Clusters:** the 68 slug-similarity clusters from the backlog findings (Jaccard of 0.5 or more on slug words, filler words dropped), re-run on this tree. Each was read by section headings and compared by 5-word shingle overlap of prose and of code. One extra pair (Falco) turned up while checking the publish queue.
- **Search data:** the blog-metrics exporter `/report` (generated 2026-10-26) has no page-level search rows, and none of the posts below are in its top-20 pageview list, so no keeper was chosen on clicks or impressions. Re-check once step 0 (the GSC page export) exists.
- **Evidence used, in order:** already published (all keepers are), coverage and specificity (section list), prose word count with code excluded, internal links pointing at the post, and time live. Where a 2026 "complete guide" rewrite repeats a shorter 2024 or 2025 original with less prose, the original stays.
- **Retired** means `draft: true` (a hold, the file is kept) plus a 301 in `src/post-redirects.json`. Tags that only a retired post carried were added to its keeper, so those tag pages keep resolving (`check:urls`). Links in other posts that pointed at a retired URL now point at the keeper.
- No unique sections were merged into keepers. Where a retired post had a section the keeper lacks, the reason column says so.

## Retired, already published (301)

| Cluster | Keeper | Retired | Reason | Redirect |
|---|---|---|---|---|
| NGINX ingress tuning (item 4) | `/nginx-ingress-controller-tuning-performance-optimization-enterprise-guide/` | `/nginx-ingress-controller-tuning/` | Body is a placeholder line, 58 words | 301 |
| Legacy TLS title (item 4) | `/post/how-to-enable-legacy-tls-versions/` | `/post/how-to-check-default-coredns-configmap-of-rke-k8s-version/` | Same title and the same body as the keeper; nothing about CoreDNS, so a retitle could not make it accurate | 301 |
| Litmus chaos (item 4 title pair) | `/chaos-engineering-litmus-kubernetes/` | `/chaos-engineering-implementation-litmus-kubernetes/` | Same title, published a day apart; keeper has more prose (782 vs 547) and 28 sections | 301 |
| Litmus chaos | `/chaos-engineering-litmus-kubernetes/` | `/chaos-engineering-litmus-kubernetes-production-guide/` | Third Litmus install and experiments guide, a day later; 339 words of prose | 301 |
| Pact vs Spring Cloud Contract (item 4 title pair) | `/contract-testing-microservices-pact-vs-spring-cloud-contract/` | `/contract-testing-microservices-pact-spring-cloud-contract/` | Same title, a day apart; keeper is the structured comparison with more prose (876 vs 605). Retired post's Go Pact consumer example is not in the keeper | 301 |
| Enterprise monitoring 2025 | `/post/enterprise-cloud-monitoring-observability-2025-comprehensive-guide/` | `/post/enterprise-cloud-monitoring-observability-comprehensive-guide-2025/` | Same words reordered, same subject; 112 words of prose vs 673 | 301 |
| Enterprise monitoring 2025 | `/post/enterprise-cloud-monitoring-observability-2025-comprehensive-guide/` | `/enterprise-system-monitoring-observability-guide-2025/` | Third generic enterprise observability guide; 399 words of prose | 301 |
| Pod Security Admission | `/kubernetes-pod-security-admission-deep-dive/` | `/kubernetes-pod-security-admission/` | Deep dive covers the same setup plus modes, rollout and troubleshooting; the one inbound link was moved | 301 |
| Kernel modules | `/linux-kernel-module-development/` | `/linux-kernel-development-advanced-module-programming/` | Same subject, broadest keeper (char devices, memory, interrupts, locking, PCI). Retired post's system call section is not in the keeper | 301 |
| Kernel modules | `/linux-kernel-module-development/` | `/linux-kernel-module-development-enterprise/` | Same subject restated (memory pools, lock-free, char device) | 301 |
| Firewall automation | `/enterprise-firewall-management-advanced-network-security-automation/` | `/advanced-firewall-automation-configuration-management-enterprise-guide/` | Same subject; 106 words of prose vs 222, 2 sections | 301 |
| NVIDIA on k3s | `/post/nvidia-gpus-on-k3s/` | `/nvidia-gpu-k3s/` | 146-word version of the keeper's steps; the one inbound link was moved | 301 |
| NVIDIA on k3s | `/post/nvidia-gpus-on-k3s/` | `/deploying-nvidia-gpu-workloads-with-k3s/` | Same toolkit, device plugin and test pod steps | 301 |
| Go compiler | `/post/advanced-go-compiler-development-2025-comprehensive-enterprise-guide/` | `/post/go-compiler-development-enterprise-ast-optimization-guide-2025/` | Same subject; 108 words of prose vs 623 | 301 |
| Linux sysadmin 2025 | `/post/advanced-linux-systems-administration-2025-comprehensive-enterprise-guide/` | `/post/advanced-linux-systems-administration-enterprise-guide-2025/` | Same words reordered; 133 words of prose vs 668 | 301 |
| Go HTTP router | `/building-high-performance-http-router-golang/` | `/implementing-advanced-http-router-golang-trie/` | Both build a trie router with radix compression and middleware; highest text overlap of any pair; keeper live 10 months longer | 301 |
| Docker daemon proxy | `/configure-docker-daemon-http-proxy/` | `/docker-daemon-http-proxy/` | 2026 rewrite of the 2024 original with less prose (145 vs 238) | 301 |
| Enterprise backup and DR | `/enterprise-disaster-recovery-automated-backup-comprehensive-infrastructure-guide/` | `/enterprise-backup-disaster-recovery-comprehensive-automation-guide/` | Same subject; keeper has the concrete parts (Kubernetes backup, rclone, recovery tests) | 301 |
| Incident communication | `/incident-communication-strategies-enterprise-guide/` | `/incident-communication-strategies-production-guide/` | Same subject a day later; 664 words with a broken template heading | 301 |
| JVM in containers | `/jvm-tuning-containerized-applications-production-guide/` | `/java-jvm-tuning-containerized-microservices/` | Same subject two days apart; keeper covers more GCs and Kubernetes resources. Retired post's Spring Boot and CDS section is not in the keeper | 301 |
| Kubernetes upgrades | `/kubernetes-upgrade-best-practices/` | `/kubernetes-upgrade-guide/` | Same prepare, upgrade, post-upgrade flow 9 days apart; keeper is more specific (kubeadm, EKS, storage API versions) | 301 |
| Nagios downtime | `/nagios-downtime-command-line-curl/` | `/nagios-downtime-curl-command/` | 2026 rewrite of the 2025 original with less prose (124 vs 274) | 301 |
| Nagios NRPE root | `/nagios-run-checks-as-root-with-nrpe/` | `/nagios-root-checks-nrpe/` | 2026 rewrite of the 2025 original with less prose (174 vs 285) | 301 |
| Go memory | `/post/advanced-go-memory-management-performance-optimization-2025-guide/` | `/post/enterprise-go-memory-management-weak-pointers-performance-guide-2025/` | Keeper already covers weak pointers; 122 words of prose | 301 |
| advanced-linux family | `/advanced-linux-security-cryptography-programming/` | `/advanced-linux-cryptography-security-programming/` | Same words reordered; keeper is twice the size and adds SELinux | 301 |
| advanced-linux family | `/real-time-linux-programming-advanced/` | `/advanced-linux-realtime-systems-programming/` | Same subject; keeper covers RT scheduling, lock-free and RT kernel tuning | 301 |
| advanced-linux family | `/embedded-linux-iot-systems-programming/` | `/advanced-linux-embedded-systems-programming/` | Same subject; keeper covers kernel config, device tree, Buildroot and Yocto | 301 |
| advanced-linux family | `/advanced-linux-audio-multimedia-programming/` | `/advanced-linux-audio-dsp-programming/` | Same ALSA engine subject; keeper also covers PulseAudio and FFmpeg | 301 |
| advanced-linux family | `/advanced-linux-graphics-drm-programming/` | `/advanced-linux-graphics-gpu-programming/` | Mixes the keeper's Vulkan code with CUDA that `/high-performance-computing-gpu-programming-linux/` covers | 301 |
| Falco (found outside the slug clusters) | `/post/falco-runtime-security-kubernetes-comprehensive-guide/` | `/falco-runtime-security-container-threat-detection-enterprise-guide/` | Same subject; keeper has more prose (670) and was live 3 months longer | 301 |

30 published posts retired (4 in item 4, 26 in item 5).

## Held from the publish queue (never published, no redirect)

None. The 78 queued posts (Nov 2026 to Apr 2027) were compared against every published post by slug and title words and by topic keyword. The closest matches (`kubernetes-cluster-autoscaler-priority-expander-least-waste` vs `kubernetes-cluster-autoscaler-optimization`, `aws-eks-node-groups-karpenter-migration-guide` vs the Karpenter guide, `falco-custom-rules-...`, `kubernetes-configmap-secret-hot-reload-guide` vs the Prometheus reload post) each go deeper on one part of a topic the published post only touches. Commit `104a5d56` had already held 911 duplicate-head queue posts.

## Left alone: needs the owner's judgement

| Cluster | Posts | Why it was not decided |
|---|---|---|
| OPA Gatekeeper | `/post/enterprise-opa-gatekeeper-kubernetes-policy-management-2025/`, `/opa-gatekeeper-policy-enforcement-kubernetes-production/` | Same subject. The March post is longer (899 words of prose) but padded with career sections; the October post is more specific (constraint templates, mutation, metrics). Evidence splits |
| MetalLB | `/enterprise-metallb-bare-metal-load-balancing-kubernetes/`, `/metallb-bgp-configuration-bare-metal-kubernetes-guide/` | Same subject, near-identical size and prose; no tiebreaker |
| Pod Security Standards | `/kubernetes-pod-security-admission-deep-dive/` (keeper above), `/pod-security-standards-implementation-enterprise-guide/` | The 2026-10-21 post is the most complete PSA/PSS guide; folding the deep dive into it would make it the keeper, but it is 5 days old |
| Cilium troubleshooting | `/post/cilium-troubleshooting/`, `/post/cilium-troubleshooting-2025/` | The 2025 post is the update and should win, but its intro says "It builds on our earlier Cilium Troubleshooting Guide" and links it, so retiring needs a prose edit to the keeper |
| CVE-2025-1974 | `/ingress-nginx-cve-2025-1974-critical-vulnerability/`, `/mitigating-cve-2025-1974-ingress-nginx-rke2/` | Same CVE, but the second is RKE2 and Rancher specific. Cross-link rather than merge? |
| cert-manager | `/installing-cert-manager-on-kubernetes/`, `/cert-manager-deep-dive/`, `/enterprise-cert-manager-pki-automation-kubernetes/` | Install how-to, issuer deep dive and private PKI read as different intents |
| Smaller overlaps | DNS basics (`/post/dns-basics/`, `/dns-basics-2/`), Go on Kubernetes (`/post/deploying-distributed-go-system-kubernetes/`, `/post/deploying-go-applications-kubernetes/`), Go error handling, Go router benchmarks, AI-assisted development, Kubernetes debugging tools, multi-cluster federation, zero trust, GitOps, Go testing | Overlapping subject but a different angle or depth; low value to retire without page-level search data |

Real series kept as they are: RKE1 to RKE2 migration by tool, centralized logging parts 1 to 3, per-exporter Grafana monitoring, DevOps crash course sections, IPv6 adventures, RKE2 deep dives, the per-CNI networking posts, and the rest of the advanced-linux family (each a different subsystem).

## Follow-ups

- Buffer: any scheduled social post that links a retired URL still lands on the keeper through the 301; no queue was edited.
- After 6 to 8 weeks, check in GSC that the retired URLs show as "Page with redirect" and that keeper impressions are at least the sum of the retired ones.
