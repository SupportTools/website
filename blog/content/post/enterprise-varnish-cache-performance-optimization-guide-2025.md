---
title: "Varnish Cache Tuning: VCL, Grace, Bans and Hit Rate"
date: 2025-05-25T16:34:42-05:00
lastmod: 2026-10-23
draft: false
tags: ["Varnish", "VCL", "Caching", "HTTP", "Performance", "varnishstat", "varnishlog", "Vinyl Cache"]
categories:
- Caching
- Performance
- "Web Servers"
author: "Matthew Mattox - mmattox@support.tools"
description: "Varnish tuning that moves hit rate: cookie and query-string normalization in VCL, grace and keep, bans vs purges, storage sizing, varnishstat and varnishlog."
more_link: "yes"
quick_fix: |
  Low hit rate is almost always cookies or query strings fragmenting the cache key. Check with `varnishncsa -d -F '%{Varnish:handling}x %U%q' | sort | uniq -c`: lots of `pass` means cookies (strip them with `import cookie;` and `cookie.keep()`), lots of `miss` on the same path means unnormalized query strings (`std.querysort()` and strip `utm_*`).
  Add `set beresp.grace = 6h;` so a sick backend serves stale content instead of errors.
---

Varnish ships with a built-in VCL that is deliberately conservative: any request with a `Cookie` or `Authorization` header goes straight to the backend, and any response with `Set-Cookie` is not cached. On a real site, where every browser sends analytics cookies, that means the cache does almost nothing. This guide covers the VCL changes that actually move the hit rate, how to keep serving during backend outages, how to invalidate content safely, how to size storage, and how to prove each change with `varnishstat` and `varnishlog`.

<!--more-->

Every VCL snippet here was compiled and exercised against the official Docker images for Varnish Cache 7.7.3, 8.0.2 and 9.1.0 with identical results. It uses `vcl 4.1` syntax throughout.

> [!NOTE]
> The open source project behind Varnish Cache was renamed **Vinyl Cache** after the 8.0 release in September 2025. Vinyl Cache 9.0 renamed the binaries (`varnishd` became `vinyld`, `varnishstat` became `vinylstat`, `varnishlog` became `vinyllog` and so on) and distribution packages moved paths such as `/etc/varnish` to `/etc/vinyl-cache`. Varnish Software continues to publish Varnish Cache under the old name; the official `varnish` Docker image currently ships `varnishd` 9.1.0. The VCL in this guide is unchanged across both; only the tool names differ.

## Start by measuring the hit rate and why requests miss

You cannot tune what you have not measured. Two commands give you the picture.

### `varnishstat`: the counters

```bash
varnishstat -1 -f MAIN.client_req -f MAIN.cache_hit -f MAIN.cache_miss \
  -f MAIN.cache_hitpass -f MAIN.cache_hitmiss -f MAIN.n_lru_nuked \
  -f MAIN.n_object -f SMA.s0.g_bytes -f SMA.s0.g_space -f SMA.Transient.g_bytes
```

```text
MAIN.client_req             13         0.81 Good client requests received
MAIN.cache_hit               5         0.31 Cache hits
MAIN.cache_hitpass           0         0.00 Cache hits for pass.
MAIN.cache_hitmiss           0         0.00 Cache hits for miss.
MAIN.cache_miss              5         0.31 Cache misses
MAIN.n_object                3          .   object structs made
MAIN.n_lru_nuked             0         0.00 Number of LRU nuked objects
SMA.s0.g_bytes             757          .   Bytes outstanding
SMA.s0.g_space       104856843          .   Bytes available
SMA.Transient.g_bytes        0          .   Bytes outstanding
```

How to read them:

- **Hit ratio** is `cache_hit / (cache_hit + cache_miss)`. Requests that were passed never count as either, so also compare `cache_hit` with `client_req`: if most requests are neither hit nor miss, VCL is passing them, and that is the problem to fix first.
- **`cache_hitpass`** counts lookups that found a "hit-for-pass" marker, meaning an earlier response was declared uncacheable (usually because of `Set-Cookie` or `Cache-Control: private`).
- **`cache_hitmiss`** is the same for "hit-for-miss" markers. A high number here usually means a backend that intermittently sends uncacheable responses for URLs that should be cacheable.
- **`n_lru_nuked` climbing** means storage is full and Varnish is evicting objects to make room. Your cache is too small for the working set (see the storage section).
- `SMA.s0.*` is the first `malloc` storage; `SMA.Transient.*` is transient storage, which holds short-lived and uncacheable objects.

`varnishstat -1 -j` emits the same counters as JSON for scripts, and `varnishstat` with no arguments is a live, sortable view.

### `varnishncsa` and `varnishlog`: why each request went where it did

The fastest diagnostic is to group requests by how Varnish handled them:

```bash
varnishncsa -d -F '%{Varnish:handling}x %U%q' | sort | uniq -c | sort -rn | head
```

```text
      2 hit /page
      2 miss /page
      1 pass /page
      1 miss /list?b=2&a=1&utm_source=x
      1 miss /list?a=1&b=2
```

`-d` reads the existing shared memory log instead of waiting for new traffic. A `pass` on a page that should be cacheable means a cookie or authorization header got through. Two `miss` lines for what is logically the same URL with different query strings means the cache key is fragmented.

`varnishlog` shows the full transaction, including every change your VCL made to the URL. To see only the requests that missed:

```bash
varnishlog -g request -q 'VCL_call eq "MISS"' -i ReqURL
```

Other useful queries: `-q 'RespStatus >= 500'` for errors, `-q 'VCL_call eq "PASS"' -i ReqURL -i ReqHeader` to see the URL and headers of every passed request (the `Cookie` or `Authorization` header that caused it is usually right there), and `-q 'Timestamp:Resp[2] > 1.0'` for requests that took more than a second. `varnishtop -i ReqURL` shows the most requested URLs live, which is where to focus first.

### `varnishhist`: latency at a glance

`varnishhist` draws a live histogram of response times, with hits drawn as `|` and misses as `#`. A healthy cache shows a tall column of `|` far to the left (microseconds) and a smaller cluster of `#` further right (backend latency). If the `#` cluster is large, your hit rate is low; if it is far to the right, the backend is slow and grace (below) matters even more. Use `-P Beresptime` to plot backend response times instead.

## Fix the cache key: query strings and cookies

The full VCL used throughout is at the end of this section. Here is what each part does.

### Normalize query strings

Marketing parameters and parameter order create a separate cache object for every variation of the same page. Strip the tracking parameters your backend ignores, then sort the rest:

```vcl
import std;

sub vcl_recv {
    set req.url = regsuball(req.url, "([?&])(utm_[a-z]+|gclid|fbclid|mc_eid)=[^&]*", "\1");
    set req.url = regsuball(req.url, "&{2,}", "&");
    set req.url = regsub(req.url, "[?&]+$", "");
    set req.url = std.querysort(req.url);
}
```

With this in place, `/list?b=2&a=1&utm_source=x` and `/list?a=1&b=2` hash to the same object. Only strip parameters you have confirmed the backend does not use; stripping a real parameter serves the wrong content.

### Keep only the cookies the backend reads

Since Varnish 6.4, `vmod_cookie` ships with Varnish itself. Use it to keep an allow-list of cookies and drop everything else (analytics, A/B testing, chat widgets):

```vcl
import cookie;

sub vcl_recv {
    if (req.url ~ "^/(assets|static)/" || req.url ~ "\.(css|js|png|jpg|svg|woff2)(\?|$)") {
        unset req.http.cookie;
        return (hash);
    }
    if (req.http.cookie) {
        cookie.parse(req.http.cookie);
        cookie.keep("sessionid,csrftoken");
        set req.http.cookie = cookie.get_string();
        if (req.http.cookie == "") {
            unset req.http.cookie;
        }
    }
}
```

After this, a request with only `_ga` and `_gid` cookies is a cache hit, while a logged-in user with `sessionid` still falls through to the built-in VCL and is passed. That is the correct default: never cache personalized responses unless the backend explicitly varies on something safe.

Do not unset `beresp.http.Set-Cookie` globally to "make things cacheable". If the backend sets a session cookie on a page and you cache that response, every visitor receives the same session.

### When to touch `vcl_hash`

The default hash is the URL plus the `Host` header (or the server IP when there is no `Host`). Add to it only for real variation that the backend does not express with `Vary`, for example a language cookie you kept:

```vcl
sub vcl_hash {
    if (req.http.cookie ~ "lang=") {
        hash_data(regsub(req.http.cookie, "^.*lang=([a-z]{2}).*$", "\1"));
    }
}
```

Without a `return`, the built-in `vcl_hash` still runs afterward and adds URL and host. Prefer a correct `Vary` header from the backend where you can, but keep `Vary` values few: `Vary: User-Agent` creates one object per browser version and effectively disables the cache.

## Grace and keep: serve stale instead of errors

Every object has three timers:

- **`ttl`**: how long the object is fresh. Set from `Cache-Control: s-maxage` or `max-age`, then `Expires`, then the `default_ttl` parameter (120 seconds by default).
- **`grace`**: how long after the TTL an expired object may still be delivered while Varnish refreshes it in the background.
- **`keep`**: how long after TTL plus grace the object is kept only so Varnish can send a conditional request (`If-Modified-Since` or `If-None-Match`) and get a cheap `304` instead of a full body.

```vcl
sub vcl_recv {
    # While the backend is healthy, accept at most 10s of staleness.
    if (std.healthy(req.backend_hint)) {
        set req.grace = 10s;
    }
}

sub vcl_backend_response {
    set beresp.grace = 6h;
    set beresp.keep = 1d;

    if (beresp.status >= 500) {
        if (bereq.is_bgfetch) {
            return (abandon);
        }
        set beresp.uncacheable = true;
        set beresp.ttl = 10s;
        return (deliver);
    }
}
```

This is the pattern from the Varnish grace documentation, with one addition. Normally a client gets at most 10 seconds of stale content while a background fetch refreshes it. When the health probe marks the backend sick, `req.grace` is left alone, so the full six hours of `beresp.grace` applies and visitors keep getting pages instead of errors. `return (abandon)` on a failed background fetch keeps the existing stale object rather than replacing it with a `503`.

Grace only works with a health probe on the backend, so `std.healthy()` has something to report:

```vcl
backend default {
    .host = "app";
    .port = "8080";
    .connect_timeout = 2s;
    .first_byte_timeout = 30s;
    .probe = {
        .url = "/healthz";
        .interval = 2s;
        .timeout = 1s;
        .window = 5;
        .threshold = 3;
    }
}
```

In testing, a page with `Cache-Control: max-age=5` was fetched once, the backend was taken down, and 12 seconds later the request was still answered from cache (`Age: 12`, `X-Cache: HIT`) while `varnishadm backend.list` showed the backend as `sick`.

## Bans vs purges

**Purge** removes one object, with all its `Vary` variants, immediately. It is the right tool when you know the exact URL that changed:

```vcl
acl purgers {
    "127.0.0.1";
    "172.16.0.0"/12;
}

sub vcl_recv {
    if (req.method == "PURGE") {
        if (client.ip !~ purgers) {
            return (synth(405, "Not allowed"));
        }
        return (purge);
    }
}
```

```bash
curl -X PURGE http://varnish.internal/products/42
```

**Ban** invalidates everything matching an expression, for example a whole section of the site. Bans are not applied immediately: they go on a ban list and each cached object is checked against newer bans when it is next looked up, or by the background "ban lurker" thread. Write bans against `obj.*` fields only, so the lurker can evaluate them without a request. That is why the VCL copies the URL and host onto the object:

```vcl
sub vcl_recv {
    if (req.method == "BAN") {
        if (client.ip !~ purgers) {
            return (synth(405, "Not allowed"));
        }
        if (!req.http.x-ban-url) {
            return (synth(400, "Missing x-ban-url"));
        }
        ban("obj.http.x-host == " + req.http.host + " && obj.http.x-url ~ " + req.http.x-ban-url);
        return (synth(200, "Ban added"));
    }
}

sub vcl_backend_response {
    set beresp.http.x-url = bereq.url;
    set beresp.http.x-host = bereq.http.host;
}

sub vcl_deliver {
    unset resp.http.x-url;
    unset resp.http.x-host;
}
```

```bash
curl -X BAN -H 'x-ban-url: ^/products/' http://varnish.internal/
varnishadm ban.list
```

A ban that references `req.*` (for example `req.url ~ ...`) cannot be processed by the lurker, so it waits until every old object is requested. On a large cache the ban list grows without bound and every lookup gets slower. Watch `MAIN.bans` in `varnishstat`: if it keeps growing, some bans are not lurker friendly.

You can also ban from the CLI without any VCL: `varnishadm ban 'obj.http.x-url ~ ^/products/'`.

## Storage sizing

Varnish keeps objects in the storage backends you pass with `-s`:

```bash
varnishd -a :80 -f /etc/varnish/default.vcl \
  -s malloc,4G \
  -s Transient=malloc,512m
```

- **Size `malloc` from the working set, not the RAM.** Look at `n_lru_nuked`: if it is zero and `SMA.s0.g_space` stays large, the cache is big enough. If objects are being nuked, either add memory or shorten TTLs on content that is rarely reused.
- **Budget memory beyond `-s`.** The storage size caps the net allocation, but the process also needs on the order of 1 KB per object outside storage, and allocator fragmentation can push real usage well above the configured size. On a machine dedicated to Varnish, giving storage roughly three quarters of RAM leaves room for that; on hosts with millions of small objects, leave more.
- **Bound Transient.** Transient storage, used for short-TTL and uncacheable objects such as hit-for-pass markers and passed response bodies in flight, is **unlimited by default**. A traffic spike of large uncacheable responses can make `varnishd` run out of memory. Give it an explicit limit and watch `SMA.Transient.g_bytes`.
- **`file` storage** puts objects in a memory-mapped file. It helps only when the working set is far larger than RAM and the disk is fast; pre-create the file (for example with `dd`) so it is not fragmented.

On the official Docker image, the entrypoint already adds `-s malloc,$VARNISH_SIZE` (100M by default), so set the `VARNISH_SIZE` environment variable rather than passing a second unnamed `-s malloc` argument, which would create an additional storage instead of resizing the first.

## The complete VCL

```vcl {filename="default.vcl"}
vcl 4.1;

import std;
import cookie;

backend default {
    .host = "app";
    .port = "8080";
    .connect_timeout = 2s;
    .first_byte_timeout = 30s;
    .probe = {
        .url = "/healthz";
        .interval = 2s;
        .timeout = 1s;
        .window = 5;
        .threshold = 3;
    }
}

acl purgers {
    "127.0.0.1";
    "172.16.0.0"/12;
}

sub vcl_recv {
    if (req.method == "PURGE") {
        if (client.ip !~ purgers) {
            return (synth(405, "Not allowed"));
        }
        return (purge);
    }
    if (req.method == "BAN") {
        if (client.ip !~ purgers) {
            return (synth(405, "Not allowed"));
        }
        if (!req.http.x-ban-url) {
            return (synth(400, "Missing x-ban-url"));
        }
        ban("obj.http.x-host == " + req.http.host + " && obj.http.x-url ~ " + req.http.x-ban-url);
        return (synth(200, "Ban added"));
    }

    set req.url = regsuball(req.url, "([?&])(utm_[a-z]+|gclid|fbclid|mc_eid)=[^&]*", "\1");
    set req.url = regsuball(req.url, "&{2,}", "&");
    set req.url = regsub(req.url, "[?&]+$", "");
    set req.url = std.querysort(req.url);

    if (req.url ~ "^/(assets|static)/" || req.url ~ "\.(css|js|png|jpg|svg|woff2)(\?|$)") {
        unset req.http.cookie;
        return (hash);
    }

    if (req.http.cookie) {
        cookie.parse(req.http.cookie);
        cookie.keep("sessionid,csrftoken");
        set req.http.cookie = cookie.get_string();
        if (req.http.cookie == "") {
            unset req.http.cookie;
        }
    }

    if (std.healthy(req.backend_hint)) {
        set req.grace = 10s;
    }
}

sub vcl_backend_response {
    set beresp.http.x-url = bereq.url;
    set beresp.http.x-host = bereq.http.host;

    set beresp.grace = 6h;
    set beresp.keep = 1d;

    if (beresp.status >= 500) {
        if (bereq.is_bgfetch) {
            return (abandon);
        }
        set beresp.uncacheable = true;
        set beresp.ttl = 10s;
        return (deliver);
    }
}

sub vcl_deliver {
    unset resp.http.x-url;
    unset resp.http.x-host;
    if (obj.hits > 0) {
        set resp.http.X-Cache = "HIT";
    } else {
        set resp.http.X-Cache = "MISS";
    }
}
```

Validate before loading: `varnishd -C -f /etc/varnish/default.vcl > /dev/null` compiles the VCL and prints errors without starting anything. Note that the backend `.host` must resolve at compile time. Load it into a running instance without a restart (and without losing the cache) with:

```bash
varnishadm vcl.load v2 /etc/varnish/default.vcl
varnishadm vcl.use v2
```

## FAQ

### Why is my hit rate low even though pages have `Cache-Control: public`?

Because the built-in VCL passes any request still carrying a `Cookie` header at the end of your `vcl_recv`, before it ever looks at the response headers. Run `varnishlog -g request -q 'VCL_call eq "PASS"' -i ReqURL -i ReqHeader` and look at which cookies the passed requests carried; add the ones the backend does not need to your strip logic, or keep only the ones it does with `cookie.keep()`.

### Should I return `(hash)` early in `vcl_recv`?

Only for requests you are sure are safe to cache regardless of headers, such as static assets after removing cookies. An early `return (hash)` skips the built-in `vcl_recv`, which is what passes `Authorization` requests and non-GET methods, so returning early for everything can cache private or `POST` responses.

### How do I test VCL changes against production hostnames before switching DNS?

Point curl at the Varnish node while keeping the real hostname, with `curl --resolve www.example.com:80:10.0.0.5 -I http://www.example.com/`, and watch the `X-Cache` and `Age` headers. See [cURL Host Header: Set It With `-H`, `--resolve` or `--connect-to`](/curl-host-header/).

## Related guides

- [How to Benchmark and Optimize Cache Hit Ratios](/benchmarking-optimizing-cache-hit-ratios/)
- [Application-Level vs CDN-Level Caching](/application-level-vs-cdn-level-caching-strategy/)
- [cURL Host Header: Set It With `-H`, `--resolve` or `--connect-to`](/curl-host-header/)
