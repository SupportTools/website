---
title: "cURL Host Header: Set It With -H, --resolve or --connect-to"
date: 2024-11-25T23:00:00-05:00
lastmod: 2026-10-23
draft: false
tags: ["curl", "HTTP", "Host Header", "Bash", "TCSH"]
categories:
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Set the Host header in curl with -H 'Host: name', and use --resolve or --connect-to for HTTPS so SNI and the certificate match. Copy-paste examples."
more_link: "yes"
url: "/curl-host-header/"
quick_fix: |
  For plain HTTP, send the header yourself:
  `curl -H 'Host: www.example.net' http://203.0.113.10/`.
  For HTTPS, pin the name to an IP instead so SNI, the certificate check and the Host header all use the real name:
  `curl --resolve www.example.net:443:203.0.113.10 https://www.example.net/`.
---

Setting the HTTP Host header with cURL is how you test a virtual host, a load balancer or a new server before you change DNS. This guide gives the exact commands for HTTP and HTTPS, explains why `-H 'Host: ...'` alone fails on HTTPS, and ends with a small `hcurl` shell helper so you never have to look the syntax up again.

<!--more-->

# Introduction to Setting the Host Header with cURL

When testing server configurations before DNS changes, you often need to connect to a server (e.g., `server.example.com` or an IP address) while requesting a different hostname (e.g., `www.example.net`). The web server, ingress controller or load balancer picks the site to serve from the HTTP Host header, so that is the value you need to control.

The cURL command for this looks like:

```bash
curl --header 'Host: www.example.net' http://server.example.com
```

`-H` is the short form of `--header`, so this is the same request:

```bash
curl -H 'Host: www.example.net' http://203.0.113.10/
```

Add `-v` to see the request curl sends and confirm the header went out:

```bash
curl -v -H 'Host: www.example.net' http://203.0.113.10/ 2>&1 | grep -i '^> host'
# > Host: www.example.net
```

## HTTPS: Use `--resolve` or `--connect-to` Instead

Overriding only the Host header works for plain HTTP, but on HTTPS it usually breaks. curl takes the TLS SNI name and the name it checks the certificate against from the URL, not from your `-H` header. If the URL is `https://203.0.113.10/`, the server receives no useful SNI, returns its default certificate, and curl fails with an error such as `SSL: no alternative certificate subject name matches target host name`.

The fix is to keep the real hostname in the URL and tell curl which IP address to connect to.

### `--resolve`: pin a name to an IP

```bash
curl --resolve www.example.net:443:203.0.113.10 https://www.example.net/
```

The format is `HOST:PORT:ADDRESS`. curl uses `203.0.113.10` for `www.example.net` on port 443 only, and everything else (SNI, certificate verification, the Host header) uses `www.example.net`. It is the curl equivalent of a temporary `/etc/hosts` entry. For an IPv6 address, wrap it in brackets: `www.example.net:443:[2001:db8::10]`.

### `--connect-to`: send the request to a different host and port

```bash
curl --connect-to www.example.net:443:origin.internal:8443 https://www.example.net/
```

The format is `HOST1:PORT1:HOST2:PORT2`. curl still talks TLS and HTTP as `www.example.net`, but opens the TCP connection to `origin.internal:8443`. Use it when the target is a hostname rather than an IP, or listens on a different port.

### Skipping certificate checks

If the server only has a self-signed or not yet issued certificate, add `-k` (`--insecure`) to skip verification while testing. Do not leave `-k` in scripts that run against production.

## Lazy Solution 1: Bash Function

If you only need the HTTP form often, define a custom function, `hcurl`, which simplifies the syntax:

### Bash Function Code
```bash
function hcurl() {
  curl --header "Host: $1" "${@:2}"
}
```

### How It Works
- `$1` grabs the first argument (the host for the header).
- `${@:2}` passes all other arguments to `curl`.

This allows you to run:
```bash
hcurl www.example.net http://server.example.com
```

You can also add additional cURL options:
```bash
hcurl www.example.net --silent http://server.example.com
```

### Explanation of `${@:2}`
- `$@`: All arguments passed to the function.
- `${@:2}`: A Bash slice starting from the second argument.

This ensures `hcurl` passes everything after the first argument directly to `curl`.

## Lazy Solution 2: TCSH Alias

For TCSH users, create an alias instead:

### TCSH Alias Code
```bash
alias hcurl 'curl --header "Host: \!^" \!:2-$'
```

### How It Works
- `\!^`: The first argument (equivalent to `!:1`).
- `\!:2-$`: All arguments from the second to the last.

You can now run:
```bash
hcurl www.example.net http://server.example.com
```

### Example with Additional Options
```bash
hcurl www.example.net --silent http://server.example.com
```

## FAQ

### Why does curl ignore my Host header on HTTPS?

It does not ignore it: the header is sent inside the TLS session. The problem is that the TLS handshake happens first and uses the hostname from the URL for SNI and certificate checks. Use `--resolve` or `--connect-to` so the URL can keep the real name.

### How do I test an Ingress or load balancer before DNS points to it?

Find the external IP of the load balancer and run `curl -v --resolve app.example.com:443:<LB-IP> https://app.example.com/`. If you get the default backend or a 404, the Host rule in the Ingress does not match; see [Troubleshooting k8s Ingress](/post/k8s-ingress-troubleshooting/).

### Can I set the Host header and still follow redirects?

Yes, but be careful with `-L`. A custom `Host:` header set with `-H` is sent to every host curl follows, which can produce confusing results after a redirect to another domain. With `--resolve`, redirects to other names are resolved normally.

### How do I remove the Host header entirely?

Pass the header name with nothing after the colon: `curl -H 'Host:' http://203.0.113.10/`. That is only useful for testing how a server handles HTTP/1.0 style requests.

## Related Guides

- [Troubleshooting k8s Ingress: Ingress-Nginx and Traefik](/post/k8s-ingress-troubleshooting/)
- [Ingress-NGINX for RKE2: Overview, Troubleshooting, and Common Configurations](/rke2-ingress-nginx/)
- [How to Get Chrome to Accept a Self-Signed Certificate](/post/chrome-accept-self-signed-certificate-guide/)
- [Essential Security Headers for Modern Web Applications](/essential-website-security-headers/)
