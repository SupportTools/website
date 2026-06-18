---
title: "The DNS Ghost Domain Problem: How Stale NS Records Keep Dead Domains Alive and How to Mitigate It"
date: 2032-04-24T09:00:00-05:00
draft: false
tags: ["DNS", "Security", "BIND", "Unbound", "PowerDNS", "CoreDNS", "Kubernetes", "Caching", "CVE-2012-1033", "Resolver"]
categories:
- DNS
- Security
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep technical guide to the DNS ghost domain problem (CVE-2012-1033 lineage): how stale or malicious NS records get refreshed in recursive resolver caches to keep deleted domains resolving, and how to mitigate it across BIND, Unbound, PowerDNS, and CoreDNS."
more_link: "yes"
url: "/ghost-domain-problem-dns-stale-ns-records-mitigation/"
---

A domain gets deleted from its registry. The registrar pulls the delegation, the WHOIS record flips to a redemption state, and every reasonable assumption says the domain should stop resolving once the cached records expire. Yet weeks later, recursive resolvers across the internet are still happily returning answers for it. The domain is officially dead, but it keeps answering queries. This is the **ghost domain problem**, and it defeats the naive mental model that DNS records simply expire when their TTL runs out.

The issue is not a bug in any single resolver so much as a consequence of how delegation and caching interact. An attacker (or even an unlucky operator) can keep a delegation alive in resolver caches almost indefinitely by continually refreshing the **NS records** before they expire. For enterprises this matters far beyond academic curiosity: it affects domain takedowns, brand-protection seizures, post-acquisition cleanup, and the trustworthiness of internal monitoring that assumes a "resolving" domain is a "live" domain.

<!--more-->

## What the Ghost Domain Problem Actually Is

The ghost domain problem describes a situation where a domain that has been removed from its parent zone (the TLD registry) continues to resolve because recursive resolvers keep the domain's delegation records cached and refreshed. The original public analysis of this attack was published as **CVE-2012-1033**, which affected multiple resolver implementations including BIND, but the underlying weakness in the resolution model is older than the CVE and remains relevant on any resolver that does not actively enforce a delegation lifetime.

The short version: the parent zone (for example, the `.com` servers) stops delegating the domain, but the resolver never re-asks the parent. As long as the resolver can be persuaded to refresh the delegation from the domain's own authoritative servers, the cached NS records never expire in a way that forces a fresh referral from the parent. The domain becomes a ghost, alive in caches but absent from the registry.

This is fundamentally a **credibility and lifetime** problem. DNS resolvers cache records with a TTL, and they rank records by how authoritative the source is. When those two mechanisms combine without a hard ceiling on how long a delegation can persist, a stale or hostile delegation can outlive the registry record that should have killed it.

It is worth being precise about scope. The ghost domain problem is not the same thing as DNS cache poisoning. Cache poisoning injects forged data a resolver never legitimately fetched. The ghost domain attack uses entirely legitimate data: the domain really was delegated to those nameservers, the apex NS records really are signed by the domain's own zone, and DNSSEC validation passes cleanly throughout. Nothing is forged. The attack abuses the timing and lifetime rules around data the resolver was always entitled to cache. That distinction matters because it means DNSSEC, which is the standard answer to "how do I trust DNS data," does not address the ghost domain problem at all. DNSSEC proves a record is authentic; it says nothing about whether the delegation that points at that record should still exist.

## A Refresher on Recursive Resolution and Caching

To understand why the attack works, it helps to walk the resolution path explicitly. When a recursive resolver looks up `www.ghost-example.com` for the first time, it does not magically know where to go. It walks down the delegation tree:

```bash
# Trace the full delegation chain for a domain from the root down.
dig +trace ghost-example.com A

# Query a specific recursive resolver and inspect the NS records it caches.
dig @10.20.0.53 ghost-example.com NS +noall +answer +ttlid

# Ask the resolver only for what is in its cache, without recursion.
dig @10.20.0.53 ghost-example.com NS +norecurse
```

The walk proceeds in stages:

1. The resolver asks a **root server** for `.com`. The root returns a referral: the NS records for the `.com` zone (the gTLD servers). These referral records carry a TTL, typically 172800 seconds (48 hours).
2. The resolver asks a `.com` **gTLD server** for `ghost-example.com`. The gTLD server returns another referral: the NS records that delegate `ghost-example.com` to its authoritative servers. This is the **delegation** that the registry controls. These NS records also carry a TTL, commonly 172800 seconds.
3. The resolver asks one of the domain's **authoritative servers** for `www.ghost-example.com` and finally gets the answer record.

The critical detail is in step 2 and step 3. The delegation NS records exist in two places: in the **parent zone** (the `.com` servers, authoritative for the delegation point) and in the **child zone** (the domain's own authoritative servers, which also publish an NS record set at the apex). These two NS sets are supposed to agree, but nothing forces them to, and they are not equally trustworthy.

```bash
# Pull the delegation as the registry's TLD servers see it.
dig @a.gtld-servers.net ghost-example.com NS +noall +authority

# Pull the delegation as the domain's own authoritative servers claim it.
dig @ns1.attacker-ns.net ghost-example.com NS +noall +answer
```

### Reading the Referral You Get Back

A referral from a TLD server is not an answer; it is a pointer. Understanding the wire format makes the rest of this discussion concrete. When you query a gTLD server for a delegated name, the useful records show up in the AUTHORITY section (the delegating NS records) and the ADDITIONAL section (glue A/AAAA records for the nameservers), while the ANSWER section stays empty. A child's own server, by contrast, returns the apex NS set in the ANSWER section with the authoritative (AA) bit set.

```text
;; flags: qr rd ra; QUERY: 1, ANSWER: 0, AUTHORITY: 2, ADDITIONAL: 2

;; QUESTION SECTION:
;ghost-example.com.             IN      NS

;; AUTHORITY SECTION:
ghost-example.com.      172800  IN      NS      ns1.attacker-ns.net.
ghost-example.com.      172800  IN      NS      ns2.attacker-ns.net.

;; ADDITIONAL SECTION:
ns1.attacker-ns.net.    172800  IN      A       203.0.113.10
ns2.attacker-ns.net.    172800  IN      A       203.0.113.11
```

The 172800-second (48-hour) TTL on those AUTHORITY records is the registry's chosen lifetime for the delegation. It is the clock that should govern how long the delegation may live in any cache. The attack is, at its heart, a way to reset a *different* clock so that this one never gets a chance to expire.

### Credibility Ranking: The Forgotten Half of Caching

Most people who run DNS know about TTLs. Far fewer think about the second axis a resolver uses when deciding what to keep and what to overwrite: **credibility**, sometimes called trustworthiness. RFC 2181 ("Clarifications to the DNS Specification") defines a ranking so that when a resolver holds one copy of a record set and receives another, it can decide which one wins rather than blindly accepting the newest packet.

The ranking, from least to most trustworthy, is roughly:

1. Glue and additional-section data (lowest credibility; it is a hint, not an assertion).
2. Data from the authority section of a non-authoritative (referral) answer.
3. Data from the answer section of a non-authoritative answer.
4. Data from the authority section of an authoritative answer.
5. Data from the answer section of an authoritative answer, and locally configured data (highest credibility).

This is the machinery the ghost domain attack abuses. The delegation NS set from the parent arrives as authority-section data in a *non-authoritative* referral (rank 2). The apex NS set the child publishes about itself arrives as answer-section data in an *authoritative* answer (rank 5). By the literal credibility ranking, the child's self-asserted NS set is *more credible* than the parent's delegation. A resolver that applies credibility ranking too literally will let the highly credible child data overwrite, and crucially **refresh the TTL of**, the less credible parent delegation. That single design decision is the seam the attack pries open: the child gets to keep resetting the lifetime of its own delegation, forever, and the parent never gets consulted again.

## Why Naive Caching Keeps the Domain Alive

Here is the mechanism that turns a deleted domain into a ghost.

Suppose the domain's authoritative servers publish the apex NS records with a very long TTL, and crucially, the records are constantly being re-fetched and re-cached by the resolver before they expire. When a resolver has a cached delegation and receives a fresh, more-or-equally-credible NS answer from the authoritative servers, it can **refresh** the cached NS records, resetting their effective lifetime.

Now consider what happens at the registry. The registrar deletes the domain. The `.com` zone stops delegating `ghost-example.com`. But the resolver never goes back to the `.com` servers, because it still has a valid (refreshed) cached delegation pointing straight at the authoritative servers. The resolver short-circuits the parent entirely. As long as the authoritative servers keep answering and the resolver keeps refreshing the apex NS set, the cached delegation never expires in a way that would force a return trip to the parent zone.

The result is a self-sustaining loop:

- The cached NS record for `ghost-example.com` points at `ns1.attacker-ns.net`.
- A client queries `something-new.ghost-example.com`.
- The resolver, holding a valid cached delegation, asks `ns1.attacker-ns.net` directly.
- That server returns the answer **and** an apex NS set with a fresh TTL.
- The resolver re-caches the NS set, extending the delegation's life.
- The parent zone is never consulted, so the registry deletion is invisible to the resolver.

```bash
# A resolver that short-circuits the parent will keep returning answers
# even though the parent delegation is gone. The cached NS set is the proof.
dig @10.20.0.53 something-new.ghost-example.com A +noall +answer
dig @10.20.0.53 ghost-example.com NS +norecurse +noall +answer
```

If the second query returns NS records with a healthy TTL while the parent has stopped delegating the name, the domain is a ghost on that resolver.

### The Attacker's Keep-Alive Loop

The attacker does not need to wait for a victim to query the domain. They can drive the refresh themselves. A trivial loop run against a target resolver, asking for a unique random label each time so the query is never served from a cached *answer* and always traverses the delegation, keeps the apex NS set warm:

```bash
# Illustrative keep-alive: defeat answer caching by randomizing the label,
# forcing the resolver to use (and therefore refresh) the cached delegation.
# This is the attacker's side, shown so defenders understand the cost model.
while true; do
  label="$(head -c8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  dig "@10.20.0.53" "${label}.ghost-example.com" A +short >/dev/null 2>&1
  sleep 1800   # well inside any reasonable NS TTL
done
```

The economics are lopsided. The attacker spends one query every half hour per resolver they care about. The defender, on an unpatched or unhardened resolver, gets a delegation that never dies. That asymmetry is exactly why the fix cannot be "wait for the TTL"; the whole point of the attack is that the TTL the defender is waiting on keeps getting reset.

### Negative Caching Does Not Save You

A natural hope is that once the parent stops delegating the name, resolvers will cache an NXDOMAIN and the ghost will starve. That hope is misplaced. Negative caching (RFC 2308) only kicks in when a resolver actually *asks* and gets a "no such name" answer. A resolver holding a live, refreshed delegation never asks the parent, so it never sees the NXDOMAIN that would let it cache the negative. The negative answer exists at the parent the entire time; the ghosted resolver simply never goes to collect it. This is why the defense has to force the resolver back to the parent (via a TTL ceiling or an explicit flush) rather than relying on negative caching to do the work.

## The Abuse Scenario

The attack is most interesting in an adversarial context. A typical scenario looks like this:

1. An attacker registers `ghost-example.com` and points it at nameservers they control.
2. The domain is used for whatever the attacker wants: phishing, malware command-and-control, fast-flux infrastructure, or hosting content that will eventually attract a takedown.
3. A registrar, registry, or court orders the domain deleted. The delegation is pulled from the `.com` zone. Everyone believes the threat is neutralized.
4. The attacker's authoritative servers keep running and keep handing out apex NS records with refreshed TTLs. Every query that reaches a resolver with the cached delegation extends its life.
5. The malicious infrastructure stays reachable through resolvers that have been kept warm, sometimes for weeks after the official takedown.

The same mechanics apply, less maliciously, to operational mistakes. A company decommissions an old brand domain, removes the delegation, and assumes it is gone. If internal traffic keeps hitting the old authoritative servers (which were never shut down), internal resolvers can keep the dead domain resolving long after the registry says it is gone. This is exactly why monitoring that treats "the domain resolves" as a proxy for "the domain is healthy and properly delegated" produces a false sense of security.

There is a second, subtler harm: **stale delegation drift**. Even without an active attacker, a delegation can outlive an organization's intent. After a registrar transfer, a nameserver migration, or an acquisition, resolvers may keep serving the old NS set while the new delegation is live at the parent. Clients split between the two, and debugging becomes maddening because different resolvers give different answers for the same name.

### Why This Beats the Usual Takedown Playbook

Most takedown playbooks are written around the registry as the single source of truth. Pull the delegation, the thinking goes, and propagation does the rest within the published TTL. The ghost domain problem breaks that assumption because the registry's authority is enforced only at the moment a resolver consults it. Once a resolver has been convinced to stop consulting the parent, the registry has no remaining lever over that resolver short of the resolver operator manually intervening. A takedown that stops at "delegation pulled" can leave a long tail of resolvers, scattered across ISPs, enterprises, and cloud providers, each independently keeping the ghost alive. There is no central kill switch, which is precisely why the defenses below are distributed and resolver-side rather than registry-side.

## Diagnosing a Ghost Delegation

The defining symptom is a divergence that persists past the parent's TTL: the parent zone no longer delegates the domain (or delegates it to different servers), but a recursive resolver keeps returning the old delegation from cache. The diagnostic is to compare the two NS sets and watch whether the divergence outlives the TTL.

### Step 1: Compare the Two NS Sets by Hand

Before automating, it pays to do the comparison manually once so you recognize the shape of the problem. Three queries tell the whole story:

```bash
# 1. What does the parent (TLD) actually delegate right now?
#    Authority section of a direct query to a gTLD server is ground truth.
gtld="$(dig +short com. NS | head -n1)"
dig "@${gtld}" ghost-example.com NS +noall +authority

# 2. What is the suspect resolver currently serving from cache?
#    +norecurse means "answer only from cache, do not go fetch."
dig @10.20.0.53 ghost-example.com NS +norecurse +noall +answer

# 3. How much life is left on the cached delegation?
#    Watch the TTL count down on repeated calls; if it jumps back up,
#    something is actively refreshing the delegation.
dig @10.20.0.53 ghost-example.com NS +norecurse +noall +answer +ttlid
sleep 5
dig @10.20.0.53 ghost-example.com NS +norecurse +noall +answer +ttlid
```

A healthy cached record's TTL strictly decreases between the two `+ttlid` calls. A delegation whose TTL *resets to a high value* between calls, especially while clients are actively querying subdomains, is being kept warm. If query 1 returns an empty authority section (or SERVFAIL/NXDOMAIN) while query 2 still returns NS records with a healthy TTL, you are looking at a ghost.

### Step 2: Automate the Comparison Across Resolvers

The following script automates that comparison. It pulls the NS set from the parent (TLD) servers and the NS set a target resolver is serving, then flags a mismatch or a cached-but-undelegated condition.

```bash
#!/usr/bin/env bash
# check-ghost-delegation.sh
# Compares the NS set served by the parent (TLD) against the NS set a
# recursive resolver is currently caching. A mismatch that persists past
# the parent TTL is a strong ghost-domain signal.
set -euo pipefail

DOMAIN="${1:?usage: check-ghost-delegation.sh <domain> [resolver]}"
RESOLVER="${2:-9.9.9.9}"

tld="${DOMAIN##*.}"
parent_ns="$(dig +short "${tld}." NS | head -n1)"
if [[ -z "${parent_ns}" ]]; then
  echo "could not resolve TLD nameserver for .${tld}" >&2
  exit 2
fi

# NS set authoritatively delegated by the parent.
mapfile -t parent_set < <(dig "@${parent_ns}" "${DOMAIN}" NS +noall +authority \
  | awk '$4=="NS"{print tolower($5)}' | sort -u)

# NS set the recursive resolver is handing back to clients.
mapfile -t cached_set < <(dig "@${RESOLVER}" "${DOMAIN}" NS +short \
  | tr 'A-Z' 'a-z' | sort -u)

printf 'parent delegation: %s\n' "${parent_set[*]:-<empty>}"
printf 'resolver cache   : %s\n' "${cached_set[*]:-<empty>}"

if [[ "${#parent_set[@]}" -eq 0 && "${#cached_set[@]}" -gt 0 ]]; then
  echo "ALERT: domain not delegated at parent but still cached as live"
  exit 1
fi

diff <(printf '%s\n' "${parent_set[@]}") \
     <(printf '%s\n' "${cached_set[@]}") >/dev/null \
  || { echo "WARN: cached NS set diverges from parent delegation"; exit 1; }

echo "OK: delegation consistent"
```

Run this against several public and internal resolvers. The most damning result is the `ALERT` case: the parent has no delegation, but a resolver is still serving NS records as if the domain were live. The `WARN` case (a divergent set) is the early signal of a delegation that is drifting or being kept alive.

### Step 3: Distinguish a Ghost From a Legitimate Migration

A divergence between parent and cache is not automatically a ghost. The same script will flag a perfectly normal nameserver migration that is still propagating, or a slave that has not yet pulled the latest zone. Three checks separate the benign from the malicious:

- **Direction of divergence.** In a legitimate migration, the *parent* has the new NS set and caches are catching up to it. In a ghost, the *cache* holds an NS set the parent no longer has at all. The dangerous case is "cached but undelegated," not "cache lags parent."
- **Persistence past the TTL.** A migration converges within the parent's NS TTL (commonly 48 hours). A divergence that is still present a week later, especially one where the cached TTL keeps refreshing, is not propagation lag.
- **Registry state.** Cross-check WHOIS / RDAP. A domain in `pendingDelete`, `redemptionPeriod`, or `clientHold` whose name still resolves from a resolver cache is a ghost by definition, not a migration.

```bash
# RDAP is the modern, machine-readable WHOIS. A status of pendingDelete or
# redemptionPeriod alongside a still-resolving name confirms a ghost.
curl -s "https://rdap.org/domain/ghost-example.com" \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("status"))'
```

## Mitigation 1: Run Modern Resolvers That Enforce Delegation Lifetime

The first and most important mitigation is to run a recursor version that handles the original CVE-2012-1033 class of problem. Modern resolvers no longer treat the child's apex NS set as freely able to refresh a cached delegation indefinitely. They enforce stricter credibility rules so that the parent's delegation governs the cached lifetime, and they cap how long any delegation can persist without a fresh referral from the parent.

In practice this means:

- **BIND** in supported releases (9.18 and later are the current maintained branches) includes the credibility fixes and additional referral-path hardening. Running an end-of-life BIND is the single most common way to remain exposed. BIND specifically stopped letting a child's answer-section NS set silently extend a delegation that the parent's referral established; the parent's lifetime now governs.
- **Unbound** has long enforced strict referral handling and does not let a child arbitrarily extend a parent-controlled delegation. The `harden-referral-path` option goes further, instructing Unbound to verify the nameservers in a referral chain rather than trusting them blindly, which closes additional variants of delegation abuse.
- **PowerDNS Recursor** similarly enforces delegation credibility and provides knobs to cap record TTLs. It refuses to let in-bailiwick child data override the parent's delegation lifetime in the way the original attack required.

The conceptual fix shared across all three is the same: sever the link between "the child re-asserted its own NS set" and "therefore the delegation's lifetime resets." A patched resolver still re-fetches the apex NS set when it needs it, but the clock that decides when the resolver must return to the parent is driven by the parent's referral TTL, not by the child's self-assertions.

For Unbound specifically, the referral-path hardening is worth enabling explicitly even though it carries a small latency cost on cold lookups:

```text
# /etc/unbound/unbound.conf - referral-path hardening.
server:
    # Verify the nameservers along a referral chain before trusting them,
    # rather than accepting in-bailiwick glue at face value. Closes
    # delegation-abuse variants beyond the basic credibility fix.
    harden-referral-path: yes
```

Patching is necessary but not sufficient. Even a fully patched resolver caches NS records for the parent-supplied TTL, which is commonly 48 hours. That is a 48-hour window in which a deleted domain can still resolve. Closing that window further is a configuration choice, which the next mitigations address.

## Mitigation 2: Cap NS Record TTLs on Recursors

Every major recursor lets you impose a **TTL ceiling** so that no cached record, including a delegation, survives longer than a value you choose. Lowering the effective NS TTL from days to roughly an hour dramatically narrows the window in which a stale delegation can go unnoticed, at the cost of slightly more queries to parent zones.

The trade-off is real but small. A 48-hour gTLD NS TTL exists because TLD delegations almost never change and the registries want to minimize query load on their infrastructure. Clamping that to an hour means your resolver re-fetches a delegation it would otherwise have held for two days. For the `.com` zone that is a rounding error against the query volume a busy resolver already generates, and the safety it buys, no ghost outliving a takedown by more than your ceiling, is worth it.

For **BIND**, set a maximum cache TTL and a maximum NCACHE (negative cache) TTL in the options block:

```text
// /etc/named.conf - cap how long any record, including delegations,
// can be cached. This shrinks the ghost-domain window from days to one hour.
options {
    directory "/var/cache/bind";
    recursion yes;
    allow-recursion { 10.20.0.0/16; 127.0.0.1; };

    // Ceiling for positive answers (default is 604800 = 7 days).
    max-cache-ttl 3600;

    // Ceiling for negative (NXDOMAIN/NODATA) answers.
    max-ncache-ttl 900;

    // Reject answers whose data is less credible than what we hold.
    // Modern defaults already do the right thing; set explicitly for clarity.
    dnssec-validation auto;
};
```

For **Unbound**, the equivalent setting is `cache-max-ttl`, with `cache-max-negative-ttl` for negative answers:

```text
# /etc/unbound/unbound.conf - aggressive ceilings on cache lifetime.
server:
    interface: 10.20.0.53
    access-control: 10.20.0.0/16 allow
    access-control: 127.0.0.0/8 allow

    # No cached record, delegation included, lives longer than an hour.
    cache-max-ttl: 3600
    cache-max-negative-ttl: 900

    # Harden referral handling and validation.
    harden-glue: yes
    harden-dnssec-stripped: yes
    harden-referral-path: yes
    qname-minimisation: yes
```

For **PowerDNS Recursor**, use `max-cache-ttl` (and the negative-answer equivalent) in `recursor.conf`:

```text
# /etc/powerdns/recursor.conf - clamp cache lifetimes.
local-address=10.20.0.53
allow-from=10.20.0.0/16, 127.0.0.0/8

# Ceiling on positive cache entries, in seconds.
max-cache-ttl=3600

# Ceiling on negative cache entries, in seconds.
max-negative-ttl=900

# Enable QName minimisation and DNSSEC validation.
qname-minimization=yes
dnssec=validate
```

A one-hour ceiling is a reasonable enterprise default. It keeps cache-hit ratios high for the long tail of normal traffic while ensuring that no delegation can outlive a takedown by more than an hour. For resolvers dedicated to security monitoring, an even lower ceiling (300 to 600 seconds) is defensible because correctness matters more than cache efficiency there.

### Verifying the Ceiling Actually Took Effect

Setting the option is not the same as the option working. A common mistake is to set `max-cache-ttl` but leave a higher value somewhere else in an include file, or to forget to reload the daemon. Verify empirically by querying a name whose authoritative TTL exceeds your ceiling and confirming the resolver reports the clamped value:

```bash
# Pick a name with a long authoritative TTL (gTLD NS records are 172800s).
# After clamping to 3600, the resolver should never report more than 3600.
dig @10.20.0.53 com. NS +noall +answer | awk '{print $2, $1}'

# Expected: every TTL is <= 3600. A value of 172800 means the ceiling
# is not being applied (wrong config file, stale daemon, or include order).
```

If the reported TTL still exceeds your ceiling, the configuration did not take. Reload (not just edit) the daemon: `rndc reconfig` for BIND, `unbound-control reload`, or `rec_control reload-acls` plus a service reload for PowerDNS Recursor.

## Mitigation 3: Actively Flush Suspect Delegations

When you confirm a ghost delegation, you do not have to wait for the TTL to expire. Every recursor can flush a name from cache on demand. Build this into your takedown and incident-response runbooks so that the moment a domain is seized or decommissioned, the relevant internal resolvers are flushed.

For **BIND** via `rndc`:

```bash
# Flush a single name from a BIND recursor's cache (BIND 9.4+).
rndc flushname ghost-example.com

# Flush the entire cache tree under a zone, including subdomains.
# This is the right tool for a delegation takedown: it removes the apex
# NS set AND every cached subdomain that the ghost was serving.
rndc flushtree ghost-example.com

# Confirm the entry is gone by dumping the cache and grepping.
rndc dumpdb -cache
grep -i ghost-example /var/cache/bind/named_dump.db || echo "not cached"
```

For **Unbound** and **PowerDNS Recursor**:

```bash
# Unbound: drop a name and its subtree from the cache.
unbound-control flush_zone ghost-example.com

# Inspect what Unbound is currently caching for the name.
unbound-control dump_cache | grep -i ghost-example || echo "not cached"

# PowerDNS Recursor: wipe a name and everything beneath it.
rec_control wipe-cache ghost-example.com$
```

The trailing `$` in the PowerDNS `wipe-cache` command anchors the wipe to the exact name and its subtree, which is the behavior you want for a delegation takedown. Without it, `wipe-cache` treats the argument as a suffix and can remove far more than you intended; with it, you remove `ghost-example.com` and `*.ghost-example.com` but leave unrelated names alone.

For an enterprise with a resolver fleet, wrap these commands in a small automation that fans out to every recursor. Flushing one resolver while leaving twenty others warm does nothing for the user who happens to land on a stale cache.

### Fanning the Flush Across a Resolver Fleet

The flush-one-resolver problem is the operational heart of incident response here. A single ghost can be cached independently on every recursor in your estate, and each one keeps the threat reachable for whoever it serves. A minimal fan-out wrapper turns a per-host command into a fleet operation:

```bash
#!/usr/bin/env bash
# fanout-flush.sh - wipe a ghost delegation from an entire BIND fleet.
# Reads one resolver host per line from a file and flushes the name+subtree
# from each via rndc over SSH. Reports per-host success so a single
# unreachable resolver does not silently leave a ghost alive.
set -uo pipefail

DOMAIN="${1:?usage: fanout-flush.sh <domain> [resolver-list-file]}"
LIST="${2:-/etc/dns/recursors.txt}"

while read -r host; do
  [[ -z "${host}" || "${host}" == \#* ]] && continue
  if ssh -o ConnectTimeout=5 "${host}" "rndc flushtree ${DOMAIN}" 2>/dev/null; then
    printf 'flushed: %s\n' "${host}"
  else
    printf 'FAILED : %s (investigate manually)\n' "${host}" >&2
  fi
done < "${LIST}"
```

The important property is that a failure is loud. A flush that silently skips an unreachable resolver leaves a ghost alive on exactly the host you forgot about, which is the worst outcome because you will believe the takedown is complete. After fanning out, re-run `check-ghost-delegation.sh` against each resolver to confirm the cache is actually clear rather than trusting the flush command's exit code alone.

## Internal DNS and Kubernetes CoreDNS

The ghost domain problem is usually discussed in the context of public DNS, but the same mechanics apply to **internal resolvers** and to **CoreDNS** inside Kubernetes clusters. CoreDNS is a recursive resolver for cluster workloads, and when it forwards to upstream resolvers it caches the answers, NS records included. A stale internal delegation, an upstream that keeps a ghost alive, or a decommissioned internal zone whose authoritative servers were never shut down can all produce the same symptom: pods resolving a name that should be dead.

The relevant CoreDNS knobs are the `cache` plugin (which controls TTL handling) and the `forward` plugin (which determines which upstream the cluster trusts). A typical hardened Corefile shipped as a ConfigMap looks like this:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns
  namespace: kube-system
data:
  Corefile: |
    .:53 {
        errors
        health {
            lameduck 5s
        }
        ready
        kubernetes cluster.local in-addr.arpa ip6.arpa {
            pods insecure
            fallthrough in-addr.arpa ip6.arpa
            ttl 30
        }
        prometheus :9153
        forward . 10.20.0.53 {
            max_concurrent 1000
        }
        cache 30 {
            success 9984 30
            denial 9984 5
        }
        loop
        reload
        loadbalance
    }
```

Two settings matter for ghost-domain resilience. First, the `cache` plugin's TTL argument (`cache 30`) caps how long CoreDNS holds any answer, and the per-class `success` and `denial` arguments cap the positive and negative cache sizes and lifetimes. Keeping this ceiling low, on the order of 30 seconds for external names, means a stale delegation cannot persist in the cluster cache. Second, the `forward` plugin should point at a hardened, patched upstream recursor (the `10.20.0.53` resolver above), so the cluster inherits the parent-credibility and TTL-ceiling protections you configured upstream rather than blindly trusting whatever the public internet hands back.

### Why the CoreDNS Cache TTL Argument Matters More Than It Looks

The `cache` plugin's first argument is a maximum, not a fixed value. CoreDNS will honor a record's own TTL up to that ceiling, so `cache 30` means "cache for the record's TTL, but never longer than 30 seconds." This is structurally the same TTL-ceiling defense applied to recursors, but at the cluster edge. It is also the reason a misconfigured CoreDNS can be a ghost-amplifier: if someone bumps the cache plugin to `cache 3600` to cut upstream query volume during a noisy-neighbor incident, they have just widened the cluster's ghost-domain window from 30 seconds to an hour. Treat that argument as a security-relevant setting, not merely a performance knob.

A second, subtler CoreDNS concern is forwarding to *multiple* upstreams. If `forward . 10.20.0.53 8.8.8.8` points at both a hardened internal recursor and a public resolver, the cluster's behavior depends on which upstream answered, and a ghost living on the public resolver leaks into the cluster on every query the hardened one did not happen to serve. Forward to a single, controlled, hardened upstream (or a pool you fully control) so the cluster's exposure is the exposure you configured, not a coin flip per query.

### Reloading CoreDNS to Clear a Ghost

When you do confirm a ghost in the cluster, reload CoreDNS to clear its cache without a disruptive restart:

```bash
# CoreDNS pods: identify the running version and reload config without restart.
kubectl -n kube-system get deploy coredns -o jsonpath='{.spec.template.spec.containers[0].image}'
kubectl -n kube-system exec deploy/coredns -- kill -USR1 1

# Verify the forward plugin and its upstream from inside the cluster.
kubectl -n kube-system get configmap coredns -o yaml

# Confirm the ghost is gone from the cluster's perspective by querying
# CoreDNS directly from a debug pod (does the cluster still resolve it?).
kubectl run dnscheck --rm -it --image=ghcr.io/supporttools/dnsutils:latest --restart=Never -- \
  dig ghost-example.com NS +short
```

The `reload` plugin in the Corefile also picks up ConfigMap changes automatically, so editing the cache TTL and waiting for the reload interval is the least disruptive path for a configuration change. A signal-based reload is the right tool for an urgent cache clear. Note that the signal reload only re-reads configuration; the surest way to flush *cached entries* specifically is to roll the CoreDNS pods (`kubectl -n kube-system rollout restart deploy/coredns`), which starts each replica with an empty cache. With only a few hundred milliseconds of lameduck, that rollout is effectively non-disruptive for clients that retry.

## Monitoring for Stale Delegations

The most pragmatic defense for an enterprise is not trying to "fix DNS" but narrowing the window in which a stale delegation goes unnoticed. That means turning the diagnostic from earlier into a continuous check and alerting on divergence.

Export two signals per monitored domain: whether the parent still delegates the name, and whether the resolver's cached NS set matches the parent. A small exporter can run the `check-ghost-delegation.sh` logic on a schedule and publish the results as Prometheus metrics. The alerting rules then look like this:

```yaml
groups:
  - name: dns-ghost-domain
    rules:
      - alert: DelegationCacheDivergence
        expr: dns_delegation_mismatch == 1
        for: 2h
        labels:
          severity: warning
          team: platform-dns
        annotations:
          summary: "Resolver cache NS set diverges from parent delegation"
          description: >-
            Domain {{ $labels.domain }} is served from cache with an NS set
            that no longer matches the parent zone delegation. This is the
            classic ghost-domain signature; investigate before the next
            renewal or takedown window.
      - alert: DomainResolvesButUndelegated
        expr: probe_dns_lookup_time_seconds > 0 and on(domain) dns_parent_delegation_present == 0
        for: 1h
        labels:
          severity: critical
          team: platform-dns
        annotations:
          summary: "Domain still resolving with no parent delegation"
          description: "{{ $labels.domain }} answers queries but has no delegation at the TLD."
```

The `for` clauses are deliberately long. A momentary mismatch during a legitimate nameserver migration is normal; a mismatch that persists for two hours past the parent's view is the ghost-domain signature. The second alert is the dangerous case for security monitoring: a domain that resolves but is not delegated at the parent is either a ghost being kept alive or a monitoring blind spot, and either way it deserves a page.

### A Minimal Exporter

The exporter does not need to be elaborate. A short script that emits Prometheus text-format metrics, dropped into a node_exporter textfile collector directory or scraped via a tiny HTTP wrapper, is enough to wire the diagnostic into your existing monitoring:

```bash
#!/usr/bin/env bash
# ghost-exporter.sh - emit Prometheus textfile metrics for ghost detection.
# Run from cron into the node_exporter textfile collector directory.
set -uo pipefail

OUT="/var/lib/node_exporter/textfile/dns_ghost.prom"
RESOLVER="10.20.0.53"
DOMAINS=( "ghost-example.com" "old-brand.example" "decommissioned.internal" )

tmp="$(mktemp)"
{
  echo "# HELP dns_parent_delegation_present 1 if the parent still delegates the name."
  echo "# TYPE dns_parent_delegation_present gauge"
  echo "# HELP dns_delegation_mismatch 1 if cached NS set diverges from parent."
  echo "# TYPE dns_delegation_mismatch gauge"
  for d in "${DOMAINS[@]}"; do
    tld="${d##*.}"
    pns="$(dig +short "${tld}." NS | head -n1)"
    parent="$(dig "@${pns}" "${d}" NS +noall +authority | awk '$4=="NS"{print tolower($5)}' | sort -u)"
    cached="$(dig "@${RESOLVER}" "${d}" NS +short | tr 'A-Z' 'a-z' | sort -u)"

    present=1; [[ -z "${parent}" ]] && present=0
    mismatch=0; [[ "${parent}" != "${cached}" ]] && mismatch=1

    printf 'dns_parent_delegation_present{domain="%s"} %d\n' "${d}" "${present}"
    printf 'dns_delegation_mismatch{domain="%s"} %d\n' "${d}" "${mismatch}"
  done
} > "${tmp}"
# Atomic move so the collector never reads a half-written file.
mv "${tmp}" "${OUT}"
```

The atomic `mv` matters: the node_exporter textfile collector can read the file at any moment, and a half-written file produces parse errors and gaps in your metrics. Generate to a temp file and rename into place.

The deeper monitoring lesson is to **stop treating "resolves" as "live."** Uptime checks that depend on a shared, warm resolver cache will report a deleted domain as healthy. Running a dedicated local resolver per monitoring worker, with an aggressive TTL ceiling, removes the shared-cache illusion and makes the monitor's view of the domain track the registry far more closely.

## Operational Hygiene

Several non-technical practices close the remaining gaps:

- **Shut down authoritative servers as part of decommissioning.** The ghost depends on the authoritative servers continuing to answer. If you control them and the domain is being retired, take them offline. A delegation with no live authoritative server collapses far faster.
- **Treat takedowns as multi-step, not single-step.** Pulling the registry delegation is step one. Flushing your resolver fleet and verifying that public resolvers have aged out the cached delegation are steps two and three. Track them to completion.
- **Inventory internal zones and their authoritative servers.** Acquisitions, migrations, and abandoned projects leave orphaned authoritative servers running for years. Those are exactly the servers that keep an internal ghost alive.
- **Keep recursors patched.** End-of-life resolver versions reintroduce the original CVE-2012-1033 weakness. Patch cadence is a security control here, not just a maintenance chore.
- **Lower TTL ceilings on security-critical resolvers.** For resolvers that feed monitoring, threat detection, or takedown verification, prioritize correctness over cache efficiency.
- **Audit CoreDNS cache and forward settings in CI.** A `cache` ceiling bumped during a performance incident, or a second public upstream added to `forward`, can quietly widen your ghost window. Lint the Corefile in your pipeline so those changes get reviewed.
- **Write the flush into the runbook, not the engineer's memory.** During an incident, "remember to flush every resolver" is the step that gets skipped. Codify the fan-out flush and the post-flush verification as explicit, checkable actions.

## A Mental Model to Keep

If you remember one thing, make it this: a delegation in a resolver's cache has two independent clocks. One is the TTL, which everyone thinks about. The other is "when will this resolver next be forced to ask the parent," which almost no one thinks about, and which the ghost domain attack drives toward infinity. Every defense in this article is ultimately a way to put a hard bound on that second clock, either by patching the resolver so the child cannot reset it, by capping the TTL so it expires soon regardless, or by manually flushing so it expires now. Registries control delegations only at the moment a resolver asks; your job as an operator is to make sure your resolvers keep asking.

## Conclusion

The ghost domain problem is a reminder that DNS resolution is a distributed, eventually-consistent system, and that "the record will expire" is a weaker guarantee than it appears. A deleted domain can outlive its own deletion by hours or days, and a determined attacker can stretch that into weeks by keeping resolver caches warm. The defense is layered: patched resolvers that enforce parent credibility, TTL ceilings that cap how long any delegation can persist, active flushing during incident response, and monitoring that detects the parent-versus-cache divergence that defines a ghost.

Key takeaways:

- The ghost domain problem (CVE-2012-1033 lineage) lets a deleted domain keep resolving because resolvers refresh cached NS records from the child's authoritative servers instead of re-consulting the parent.
- It is not cache poisoning and DNSSEC does not address it; the data is authentic, the attack abuses caching *lifetime* and RFC 2181 credibility ranking, not authenticity.
- Naive caching short-circuits the parent zone, so the registry deletion is invisible to a resolver that holds a refreshed delegation, and negative caching never helps because the resolver never asks the parent.
- Modern, patched BIND, Unbound (with `harden-referral-path`), and PowerDNS Recursor enforce delegation credibility, but the parent's TTL (often 48 hours) still bounds the exposure window unless you cap it.
- Cap NS and cache TTLs (`max-cache-ttl`, `cache-max-ttl`, `max-cache-ttl`) to roughly one hour, or lower on security-critical resolvers, and verify the ceiling took effect by reading back a long-TTL record's reported TTL.
- Flush suspect delegations on demand with `rndc flushtree`, `unbound-control flush_zone`, and `rec_control wipe-cache ...$`, and fan the flush across the whole resolver fleet with loud per-host failure reporting.
- CoreDNS in Kubernetes is a recursive resolver too; keep its `cache` TTL low, treat that argument as security-relevant, and point `forward` at a single hardened upstream rather than a public coin flip.
- Diagnose by comparing the parent's authority-section NS set against a resolver's `+norecurse` cached set, watch whether the cached TTL refreshes, and cross-check RDAP to separate a ghost from a legitimate migration.
- Monitor for the parent-delegation-versus-resolver-cache divergence, export it as Prometheus metrics, and stop treating "resolves" as proof that a domain is properly delegated and live.
- Shut down authoritative servers and flush caches as explicit steps in every domain decommission and takedown runbook.
