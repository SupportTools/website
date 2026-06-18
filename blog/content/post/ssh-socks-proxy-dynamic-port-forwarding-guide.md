---
title: "The Complete Guide to SSH SOCKS Proxies: Dynamic Port Forwarding for Secure Admin Access"
date: 2032-05-11T09:00:00-05:00
draft: false
tags: ["SSH", "SOCKS5", "Port Forwarding", "Bastion", "Jump Host", "Networking", "Kubernetes", "Security", "DevOps", "Linux", "autossh", "Zero Trust"]
categories:
- SSH
- Networking
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete, enterprise-focused guide to SSH SOCKS proxies and dynamic port forwarding (ssh -D): how it works, browser and OS setup, remote DNS, ~/.ssh/config, autossh, and reaching private Kubernetes clusters through a bastion."
more_link: "yes"
url: "/ssh-socks-proxy-dynamic-port-forwarding-guide/"
---

Every operations engineer eventually hits the same wall: a service, a database, an internal dashboard, or a Kubernetes API server that lives on a private subnet with no public route. The infrastructure is doing exactly what it should — refusing to expose internal endpoints to the internet — but you still need to reach it to do your job. The wrong answer is to punch a hole in the firewall or attach a public IP. The right answer, in most cases, is an **SSH SOCKS proxy**: a single encrypted tunnel through a host you are already authorized to log into, turning that host into a controlled, auditable entry point for arbitrary TCP traffic.

This is the canonical reference for SSH dynamic port forwarding (`ssh -D`). It explains how dynamic forwarding actually works and how it differs from local (`-L`) and remote (`-R`) forwarding, how to stand it up on Linux, macOS, and Windows, how to point a browser or an entire CLI toolchain at the resulting **SOCKS5** proxy — including the critical detail of pushing **DNS resolution** through the tunnel — how to make the setup persistent and resilient with `~/.ssh/config` and `autossh`, and how this pattern maps onto the most common real-world case: reaching a private Kubernetes cluster through a bastion. Everything here is framed around authorized administrative and secure-access use; an SSH tunnel is only as legitimate as your right to log into the host on the far end.

<!--more-->

## What Dynamic Port Forwarding Actually Is

SSH has always been able to carry more than an interactive shell. Inside a single authenticated connection it can multiplex additional channels, and **port forwarding** is the feature that exposes those channels as ordinary network sockets on one end of the connection. There are three forwarding modes, and conflating them is the root of most confusion.

- **Local forwarding (`-L`)** maps one local port to one specific remote host and port. `ssh -L 5432:db.internal:5432 bastion` means "anything I send to `localhost:5432` comes out of the bastion aimed at `db.internal:5432`." It is a fixed, one-to-one pipe. You need a separate `-L` for every destination.
- **Remote forwarding (`-R`)** is the mirror image: it opens a listening port *on the remote host* that tunnels back to a host reachable from your side. This is how you expose a local service to a remote network, and the mechanism behind tools like reverse SSH tunnels.
- **Dynamic forwarding (`-D`)** is the one that changes the game. Instead of a fixed destination, SSH opens a local **SOCKS proxy** listener. Client applications speak the SOCKS protocol to that listener, telling SSH *at connection time* where they want to go. SSH then opens a channel to that destination from the remote end. One tunnel, unlimited destinations, decided per-connection by the client.

The practical difference is enormous. With `-L`, reaching ten internal services means ten forwards and ten local ports your applications must be reconfigured to use. With `-D`, you start one proxy and any SOCKS-aware application can reach *any* host the bastion can route to, using the real internal hostnames and ports. The bastion becomes a general-purpose, encrypted on-ramp to its network segment.

### Comparing the Three Forwarding Modes

The table below is the mental model worth committing to memory. The key axis is *who decides the destination* and *when*: with `-L` and `-R` the destination is fixed at the moment you start the tunnel, while with `-D` the client chooses it at connection time.

| Aspect | Local (`-L`) | Remote (`-R`) | Dynamic (`-D`) |
| --- | --- | --- | --- |
| Listener location | Your local machine | The remote/SSH server | Your local machine |
| Destination | Fixed, one host:port | Fixed, one host:port | Any host:port, chosen per-connection |
| Who chooses target | You, at startup | You, at startup | The client app, via SOCKS, at runtime |
| Protocol exposed | Raw TCP on a local port | Raw TCP on a remote port | A SOCKS4/SOCKS5 proxy |
| Typical use | Reach one internal service | Expose a local service outward | Browse an entire private network |
| Forwards per destination | One per target | One per target | One tunnel for everything |
| Remote DNS | N/A (you supply the host) | N/A | Yes, with SOCKS5 hostnames |
| Canonical example | `-L 5432:db.internal:5432` | `-R 8080:localhost:80` | `-D 1080` |

A useful way to internalize the distinction: `-L` pulls a *specific* remote resource toward you, `-R` pushes a *specific* local resource outward, and `-D` opens a *general* doorway you can walk through to anywhere the far end can reach. The first two are point-to-point plumbing; the third is a routing primitive. For administrative access to a private subnet, `-D` is almost always the correct tool, because the set of things you need to reach is open-ended and you do not want to predeclare each one.

### SOCKS4 vs SOCKS5, and Why the Version Matters

**SOCKS** (Socket Secure) is a thin proxy protocol that operates below the application layer. Unlike an HTTP proxy, it does not understand or modify the traffic it carries — it simply relays TCP (and, in SOCKS5, optionally UDP) connections to a destination the client specifies. OpenSSH's dynamic forwarding implements both the older **SOCKS4** and the modern **SOCKS5**, and a client may negotiate either against the same `-D` listener. The differences are small in count but large in consequence:

- **Address types.** SOCKS4 carries only IPv4 addresses. The SOCKS4a extension bolted on hostname support, but it is inconsistently implemented. SOCKS5 natively carries IPv4, IPv6, *and* domain names, which is the feature that makes remote DNS resolution work cleanly.
- **Authentication.** SOCKS4 has no real authentication. SOCKS5 defines an authentication negotiation phase (none, username/password, GSSAPI). With `ssh -D` the SSH layer already authenticates you, so the SOCKS layer typically uses "no authentication" — but the framework exists.
- **UDP.** SOCKS4 is TCP-only. SOCKS5 can relay UDP associations. Note that OpenSSH's `-D` forwards TCP only regardless of SOCKS version, so UDP-dependent protocols (including plain DNS over UDP) will not traverse the tunnel; this is precisely why remote name resolution is handled inside the SOCKS5 handshake rather than as separate UDP DNS traffic.

The version matters for one reason above all: **SOCKS5 can carry a destination hostname**, not just an IP address. That single capability is what lets you resolve internal DNS names through the tunnel, which is covered in detail below. When you configure a client, always choose SOCKS5 (sometimes labeled "SOCKS v5") so remote name resolution is available; reach for SOCKS4 only when a legacy client offers nothing newer.

## Standing Up the Proxy on Linux and macOS

The OpenSSH client on Linux and macOS is identical for this purpose, so the same commands work on both. Before the first tunnel, confirm two prerequisites: you can authenticate to the bastion with a key (not a password), and the bastion's server configuration permits TCP forwarding. The key check is a one-liner:

```bash
#!/usr/bin/env bash
# Confirm key-based auth works and forwarding is not blocked by the server.
# BatchMode=yes makes SSH fail instead of prompting, so password auth shows up
# as a clean failure rather than a hang.
ssh -o BatchMode=yes -o ConnectTimeout=10 mmattox@bastion.corp.example.com 'echo auth-ok; sshd -T 2>/dev/null | grep -i allowtcpforwarding || true'
```

If that prints `auth-ok` you have working key authentication. The `allowtcpforwarding` line (visible when you can read the server config) should report `yes` or `local`; if a hardened bastion sets `AllowTcpForwarding no`, dynamic forwarding is disabled at the server and no client flag will change that — it must be enabled, ideally narrowly, on the server side (covered in the security section).

The minimal form is a single command:

```bash
#!/usr/bin/env bash
# Start a SOCKS5 proxy on localhost:1080 tunneled through the bastion
ssh -D 1080 -N -f mmattox@bastion.corp.example.com

# -D 1080  : open a dynamic (SOCKS) listener on local port 1080
# -N       : do not execute a remote command (tunnel only)
# -f       : drop to the background after authentication completes
```

Three flags carry the weight. `-D 1080` opens the SOCKS listener on local port `1080` — a conventional but arbitrary choice; any unused high port works. `-N` tells SSH not to run a remote command, because you want a tunnel, not a shell. `-f` sends SSH to the background once authentication is done, so it does not tie up your terminal. Drop `-f` while you are testing so you can see errors and kill the tunnel with `Ctrl+C`.

### Binding the Listener Deliberately

By default OpenSSH binds the dynamic listener to the loopback interface, which is exactly what you want: only processes on your own machine can use the proxy. Make that explicit, and understand the alternative, because the alternative is a common mistake:

```bash
#!/usr/bin/env bash
# Bind only to loopback so no other host can use the proxy (default, explicit)
ssh -D 127.0.0.1:1080 -N -f mmattox@bastion.corp.example.com

# Bind to all interfaces — AVOID unless you fully trust the network
ssh -D 0.0.0.0:1080 -N -f mmattox@bastion.corp.example.com
```

Binding to `0.0.0.0` turns your workstation into an **open proxy** for everyone on your LAN, who would then be tunneling into the corporate network through your credentials with no authentication of their own. Never do this on an untrusted network. If multiple people legitimately need the same tunnel, each should run their own, authenticated with their own key. Note that `0.0.0.0` binding also requires `GatewayPorts` behavior to be permitted by the client configuration; the safe default is loopback only.

### Watching It Connect

When a tunnel will not come up, run it in the foreground with verbose logging. This is the first diagnostic step, every time:

```bash
#!/usr/bin/env bash
# Run in the foreground with verbose output to diagnose tunnel setup
ssh -vvv -D 1080 -N mmattox@bastion.corp.example.com
```

The verbose output shows key negotiation, authentication method selection, and — importantly — whether the local forward listener was actually established. The line you are looking for confirms a listen on `127.0.0.1` port `1080`. If authentication succeeds but the listener never appears, the problem is almost always a port conflict on the local side.

Confirm the listener independently:

```bash
#!/usr/bin/env bash
# With the Host block defined in ~/.ssh/config, this is all you need
ssh -N -f bastion-socks

# Verify the listener is up
ss -tlnp | grep 1080
```

If `ss` (or `netstat -tlnp` on older systems) shows `ssh` listening on `127.0.0.1:1080`, the proxy is ready for clients.

### Reusing One Connection with Multiplexing

When you open many short-lived SSH sessions to the same bastion — a tunnel here, an interactive shell there, a quick `scp` — each one repeats the full TCP and cryptographic handshake, which is slow and, on hosts with rate limiting or hardware tokens, occasionally painful. OpenSSH's connection multiplexing solves this: the first connection becomes a *master* that opens a control socket, and subsequent connections to the same host ride inside it as new channels, skipping authentication entirely.

```ini
# ~/.ssh/config — multiplex all connections to the bastion over one master
Host bastion.corp.example.com
    User mmattox
    ControlMaster auto
    ControlPath ~/.ssh/cm-%r@%h:%p
    ControlPersist 10m
```

`ControlMaster auto` makes the first connection the master and lets later ones reuse it. `ControlPath` names the per-connection control socket; the `%r@%h:%p` tokens (remote user, host, port) keep sockets distinct so different targets do not collide. `ControlPersist 10m` keeps the master alive in the background for ten minutes after the last session closes, so a follow-up command within that window connects instantly. This composes naturally with dynamic forwarding: a long-lived `-D` tunnel can act as the master, and your ad-hoc shells into the same bastion attach to it for free. To inspect or tear down a master deliberately:

```bash
#!/usr/bin/env bash
# Check the master's status, then close it cleanly
ssh -O check bastion.corp.example.com
ssh -O exit bastion.corp.example.com
```

One caveat: because every session shares a single transport, if the master drops, every multiplexed session drops with it. For a tunnel you depend on, that is an argument for the resilient, supervised setups described later rather than relying on a shared master for a critical proxy.

## Configuring DNS to Resolve Through the Tunnel

This is the single most misunderstood part of SOCKS proxying, and getting it wrong defeats much of the point. When a client wants to reach `intranet.corp.example.com`, *something* has to turn that name into an IP address. There are two places that can happen:

- **Local DNS resolution**: the client resolves the name on your workstation first, then asks the proxy to connect to the resulting IP. This fails for any name that only resolves inside the corporate network, and it leaks every internal hostname you visit to your local resolver.
- **Remote DNS resolution**: the client passes the *hostname* to the proxy, and the bastion resolves it on the far side using the internal resolvers. This is what you almost always want, and it is only possible because SOCKS5 can carry hostnames.

In `curl`, the distinction is a single letter in the scheme:

```bash
#!/usr/bin/env bash
# socks5h:// forces curl to resolve DNS through the proxy (remote DNS)
curl --proxy socks5h://127.0.0.1:1080 https://intranet.corp.example.com/health

# socks5:// (no h) resolves DNS locally — usually wrong for internal names
curl --proxy socks5://127.0.0.1:1080 https://example.com
```

The `h` in `socks5h` stands for "hostname" — it tells `curl` to hand the name to the proxy. Memorize that letter; it is the difference between a tunnel that reaches internal services and one that mysteriously returns `Could not resolve host` for everything behind the bastion.

The same principle applies to every SOCKS client. Browsers have an equivalent setting (covered next), `proxychains` has a `proxy_dns` directive, and language HTTP libraries usually expose a "remote DNS" flag. Whenever an internal hostname fails to resolve through an otherwise-working proxy, remote DNS is the first thing to check.

### Why DNS Leaks Matter Here

A "DNS leak" in this context is not just a privacy abstraction — it has concrete operational consequences. If your client resolves names locally, three things go wrong. First, any host that only exists in internal DNS (`db.prod.svc.cluster.local`, `vault.corp.internal`) simply fails to resolve, so the connection never even reaches the proxy. Second, the names of internal systems you are administering get sent to whatever resolver your workstation uses — a public resolver, an ISP, or a captive-portal DNS on untrusted Wi-Fi — quietly disclosing your organization's internal topology. Third, you can get *split-brain* results, where a name that resolves both publicly and privately returns the public address locally and you end up talking to the wrong system entirely. Forcing remote DNS closes all three gaps at once: resolution happens on the bastion, using the resolvers that host trusts, for names only it can see.

### proxychains: Forcing Any TCP Client Through the Proxy

Not every tool understands SOCKS or proxy environment variables. `proxychains` (commonly the `proxychains-ng` / `proxychains4` build) intercepts a program's network calls and routes them through your proxy, and it has its own remote-DNS switch. The configuration that matters lives in `proxychains4.conf`:

```text
# /etc/proxychains4.conf (or ~/.proxychains/proxychains.conf) — key lines only
# strict_chain  : use the proxies in the listed order, all of them
strict_chain
# proxy_dns     : resolve hostnames through the proxy, not locally (no leaks)
proxy_dns
# quiet_mode    : suppress the per-connection banner (optional, cleaner output)
quiet_mode

[ProxyList]
# Point at the SSH SOCKS5 listener created by `ssh -D 1080`
socks5 127.0.0.1 1080
```

The single most important directive is `proxy_dns`; without it `proxychains` resolves names on your workstation before connecting, reintroducing exactly the leak this section warns about. With it set and a `socks5` (not `socks4`) entry in the `[ProxyList]`, names are handed to the bastion. Run any client through it by prefixing the command, as shown later for `psql` and other non-proxy-aware tools.

## Pointing a Browser at the Proxy

A SOCKS proxy is most useful when a browser can use it to reach internal web applications. The configuration is browser-specific, and the remote-DNS detail reappears in each one.

### Firefox

Firefox has its own proxy stack independent of the operating system, which makes it ideal for a dedicated browsing profile. Under **Settings - Network Settings - Manual proxy configuration**, set the **SOCKS Host** to `127.0.0.1` and the port to `1080`, and select **SOCKS v5**. The critical checkbox is **"Proxy DNS when using SOCKS v5"** — enable it. Without it, Firefox resolves names locally and internal hosts will not load. Behind the scenes this maps to two `about:config` preferences worth knowing for automation:

```ini
# Firefox prefs.js / policy equivalents for a SOCKS5 proxy with remote DNS
network.proxy.socks = "127.0.0.1"
network.proxy.socks_port = 1080
network.proxy.socks_version = 5
network.proxy.socks_remote_dns = true
network.proxy.type = 1
```

Create a separate Firefox profile (`firefox -P`) for proxied work so your normal browsing is unaffected and so you can tell at a glance which window is tunneled.

### Chrome and Chromium

Chrome reads the system proxy by default, but you can launch a dedicated instance with its own proxy and profile, which avoids touching system settings entirely:

```bash
#!/usr/bin/env bash
# Launch a dedicated Chrome profile that uses the SOCKS proxy with remote DNS
google-chrome \
  --user-data-dir="$HOME/.config/chrome-socks" \
  --proxy-server="socks5://127.0.0.1:1080" \
  --host-resolver-rules="MAP * ~NOTFOUND , EXCLUDE 127.0.0.1"
```

For Chrome, specifying `socks5://` as the proxy server causes Chrome to send hostnames to the proxy for resolution, giving you remote DNS without a separate toggle. The `--user-data-dir` flag isolates this into its own profile so cookies and history do not mix with your main browser.

### A Word on System-Wide Proxy Settings

On both macOS (**System Settings - Network - Proxies - SOCKS Proxy**) and GNOME (**Settings - Network - Network Proxy**), you can set a system-wide SOCKS proxy that most applications inherit. This is convenient but blunt: it routes *everything* through the tunnel, including software update checks and telemetry, and it is easy to forget you left it on. For administrative access, a per-application or per-profile proxy is almost always the better discipline.

## Making It Reusable with ~/.ssh/config

Typing the full command every time is error-prone. Move the definition into `~/.ssh/config` and the tunnel becomes a named target you can start, script, and share as a reviewed configuration:

```ssh_config
# ~/.ssh/config — reusable SOCKS proxy definition
Host bastion-socks
    HostName bastion.corp.example.com
    User mmattox
    Port 22
    IdentityFile ~/.ssh/id_ed25519_bastion
    DynamicForward 1080
    RequestTTY no
    SessionType none
    ServerAliveInterval 30
    ServerAliveCountMax 3
    ExitOnForwardFailure yes
    Compression yes
```

With that block in place, the entire tunnel collapses to `ssh -N -f bastion-socks`. Each directive earns its keep:

- **`DynamicForward 1080`** is the config-file equivalent of `-D 1080`. You can also write `127.0.0.1:1080` to bind explicitly to loopback.
- **`RequestTTY no`** and **`SessionType none`** make this a tunnel-only connection without allocating a pseudo-terminal, the declarative form of `-N`.
- **`ServerAliveInterval 30`** and **`ServerAliveCountMax 3`** send keepalive probes every 30 seconds and tear the connection down after three missed replies (about 90 seconds), so a dead tunnel is detected promptly instead of hanging silently.
- **`ExitOnForwardFailure yes`** is a safety net: if the SOCKS listener cannot be established — usually a local port conflict — SSH exits instead of giving you a connected session with no working proxy. Without this, you can end up sending traffic into a tunnel that was never actually set up.
- **`Compression yes`** can help on high-latency links carrying compressible traffic; leave it off for already-compressed payloads.

### Chaining Through a Jump Host

The common enterprise topology has the bastion in a DMZ and the truly private hosts one hop further in. `ProxyJump` (the `-J` flag) composes cleanly with dynamic forwarding, letting you open the SOCKS listener on a host that is itself only reachable through the bastion:

```ssh_config
# ~/.ssh/config

# Reusable SOCKS tunnel to the production bastion
Host bastion-socks
    HostName bastion.corp.example.com
    User mmattox
    IdentityFile ~/.ssh/id_ed25519_bastion
    DynamicForward 127.0.0.1:1080
    RequestTTY no
    SessionType none
    ServerAliveInterval 30
    ServerAliveCountMax 3
    ExitOnForwardFailure yes

# Reach a private host through the bastion, with its own SOCKS port
Host app-socks
    HostName internal-app.corp.example.com
    User mmattox
    ProxyJump bastion-socks
    DynamicForward 127.0.0.1:1081
    ExitOnForwardFailure yes
```

Here `app-socks` opens a SOCKS listener on port `1081` whose channels originate from `internal-app.corp.example.com`, a host that is itself reached by transparently hopping through `bastion-socks`. You can run both tunnels at once on different ports and choose which network segment to egress from per application. The equivalent ad-hoc command is:

```bash
#!/usr/bin/env bash
# Open the SOCKS listener on a host reachable only through a jump host
ssh -D 1080 -N -J jump.corp.example.com mmattox@internal-app.corp.example.com
```

Always verify your configuration parses the way you expect with `ssh -G app-socks`, which prints the fully resolved settings — including the effective `dynamicforward` value — without connecting.

## Keeping the Tunnel Alive with autossh

A plain SSH tunnel dies when the network blips, the laptop sleeps, or a NAT idle timeout closes the connection. For an interactive session that is fine; for a tunnel you depend on, it is a recurring annoyance. **autossh** wraps SSH and restarts it automatically whenever it exits unexpectedly:

```bash
#!/usr/bin/env bash
# autossh restarts the tunnel automatically if it drops
export AUTOSSH_GATETIME=0
autossh -M 0 -N -f bastion-socks
```

`autossh` reuses your `~/.ssh/config`, so it inherits the `DynamicForward`, keepalive, and `ExitOnForwardFailure` settings defined there. Two flags need explanation. `-M 0` disables autossh's own monitoring port and tells it to rely on SSH's built-in `ServerAliveInterval`/`ServerAliveCountMax` keepalives instead — the modern, recommended approach, which is why those directives belong in the config block. `AUTOSSH_GATETIME=0` removes the startup grace period so autossh will keep retrying even if the very first connection fails, which matters at boot before the network is fully up.

### Running It as a systemd Service

For a tunnel that should survive logout and start at boot, wrap it in a systemd unit. A **user** service is appropriate when the tunnel belongs to one person's session and uses their key:

```ini
[Unit]
Description=SSH SOCKS proxy to corp bastion
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/ssh -N -D 127.0.0.1:1080 -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes bastion-socks
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

Save it as `~/.config/systemd/user/ssh-socks-bastion.service`, then enable and start it:

```bash
#!/usr/bin/env bash
# Reload, enable and start the user-level tunnel service
systemctl --user daemon-reload
systemctl --user enable --now ssh-socks-bastion.service
systemctl --user status ssh-socks-bastion.service
```

Note that `ExecStart` uses plain `ssh` rather than `autossh`, with `Restart=always` handling the resilience that autossh would otherwise provide. systemd's restart logic is simpler and more observable than wrapping autossh inside a unit, so prefer it when you are already in a systemd environment. For a tunnel that must persist regardless of who is logged in, use a system service running as a dedicated unprivileged account whose key is authorized on the bastion — never run such tunnels as root.

## Windows: PuTTY and Native OpenSSH

Windows offers two equally valid paths, and the right choice depends on whether the rest of your workflow is GUI- or shell-driven.

### Native OpenSSH

Modern Windows ships the OpenSSH client, so the exact same command line works in PowerShell, `cmd`, or Windows Terminal:

```bash
#!/usr/bin/env bash
# Native OpenSSH on Windows (PowerShell or cmd) uses identical flags
ssh -D 1080 -N mmattox@bastion.corp.example.com
```

Windows OpenSSH also reads `%USERPROFILE%\.ssh\config`, so the `~/.ssh/config` `Host bastion-socks` block above works without modification. This is the most consistent option for teams that already standardize on SSH config across platforms.

### PuTTY

PuTTY remains popular on Windows and configures dynamic forwarding through its GUI. In the session configuration tree, navigate to **Connection - SSH - Tunnels**. Leave **Source port** set to `1080`, leave the **Destination** field empty, and select the **Dynamic** radio button (and **Auto** / **IPv4** as appropriate). Click **Add**, and the tunnel definition appears in the list as `D1080`. Return to the **Session** category, enter the bastion hostname, and save the session under a memorable name so you can reload it. When you open that session and authenticate, PuTTY presents a SOCKS proxy on `127.0.0.1:1080` exactly as the command-line client does. For unattended PuTTY tunnels, `plink.exe` is the scriptable equivalent and accepts `-D 1080` directly.

## The Kubernetes and Operations Angle

The pattern that makes dynamic forwarding indispensable for platform teams is reaching a **private Kubernetes cluster** through a bastion. A well-architected cluster keeps its API server on a private subnet, accessible only from within the VPC or via a jump host. Rather than exposing the API server publicly, you tunnel to it.

Because `kubectl` honors the standard proxy environment variables, a SOCKS proxy is often all you need:

```bash
#!/usr/bin/env bash
# Point kubectl at a private API server reachable only via the bastion subnet
export HTTPS_PROXY=socks5://127.0.0.1:1080
kubectl --server https://10.20.0.10:6443 get nodes
```

With the tunnel up and `HTTPS_PROXY` set to the SOCKS listener, `kubectl` connects to the private API server endpoint through the bastion. Scope the variable to a single shell or wrap it in a function so it does not silently redirect unrelated traffic.

A cleaner, more durable alternative is to bind the proxy to a single cluster context inside the kubeconfig itself with the `proxy-url` field, so only `kubectl` calls to *that* cluster traverse the tunnel and nothing else in your shell is affected:

```ini
# ~/.kube/config (excerpt) — scope the SOCKS proxy to one cluster only
clusters:
- name: prod-private
  cluster:
    server: https://10.20.0.10:6443
    certificate-authority: /home/mmattox/.kube/prod-ca.crt
    # Route this cluster's API traffic through the SSH SOCKS5 proxy.
    # socks5 here resolves the API server IP locally; for a private DNS
    # name use a remote-DNS-capable proxy or an IP, as shown above.
    proxy-url: socks5://127.0.0.1:1080
```

With that in place, `kubectl --context prod-private get nodes` reaches the private API server through the bastion while every other context and shell command behaves normally. This is the recommended pattern for multi-cluster operators, because it removes the foot-gun of a stray `HTTPS_PROXY` redirecting `helm`, `aws`, or registry traffic you did not intend to tunnel.

For tools that do not honor proxy variables, `proxychains` forces any TCP client through the proxy:

```bash
#!/usr/bin/env bash
# Route an arbitrary CLI tool through the SOCKS proxy with proxychains4
proxychains4 -q psql -h db-private.corp.example.com -U appuser -d orders
```

Ensure `proxychains4.conf` lists `socks5 127.0.0.1 1080` and has `proxy_dns` enabled so the private database hostname resolves on the far side of the tunnel. This same approach reaches private container registries, internal Prometheus and Grafana instances, cloud provider metadata-style internal endpoints, and any other TCP service the bastion can route to — all through one authenticated, logged connection.

### Verifying You Are Actually Tunneled

Before trusting a tunnel with real work, confirm that traffic genuinely egresses from the bastion and not your workstation:

```bash
#!/usr/bin/env bash
# Confirm traffic egresses from the bastion, not your workstation
curl --proxy socks5h://127.0.0.1:1080 https://api.ipify.org
echo
curl https://api.ipify.org
```

The first command should report the bastion's public egress IP; the second, your local one. If they match, the proxy is not being used and you have a misconfiguration to chase. This two-line check belongs in every tunnel runbook.

To prove specifically that *DNS* is resolving on the far side — the leak check — confirm an internal-only name resolves through the proxy but not locally:

```bash
#!/usr/bin/env bash
# An internal-only name should succeed via socks5h (remote DNS) ...
curl -sS --max-time 10 --proxy socks5h://127.0.0.1:1080 https://intranet.corp.example.com/ -o /dev/null -w '%{http_code}\n'

# ... and should fail to resolve when done locally, confirming no leak path
getent hosts intranet.corp.example.com && echo "WARNING: resolves locally" || echo "OK: does not resolve locally"
```

If the first command returns an HTTP status and the second reports that the name does not resolve locally, remote DNS is working and internal names are not leaking to your workstation's resolver.

## Legitimate Use Cases

Dynamic forwarding earns its place in an operations toolkit because it maps onto a recurring, entirely legitimate need: an authorized engineer reaching private infrastructure through a host they are permitted to use. The recurring patterns are worth naming explicitly so the technique is applied where it fits and not stretched into circumventing controls.

- **Administering private subnets.** Databases, message queues, internal admin panels, and management interfaces are deliberately kept off the public internet. A SOCKS proxy through the subnet's bastion lets an on-call engineer reach them for maintenance and incident response without anyone attaching a public IP or opening a firewall rule.
- **Jump-host access to segmented networks.** In a tiered network, the bastion in the DMZ is the only host with a route into the protected tier. Dynamic forwarding (optionally chained with `ProxyJump`) turns that single permitted hop into reach across the segment, scoped by what the jump host itself is allowed to contact.
- **Reaching internal web consoles.** Grafana, Argo CD, Kibana, internal wikis, and cloud-provider private endpoints often have no public ingress by design. A dedicated proxied browser profile reaches them over the tunnel while leaving normal browsing untouched.
- **Private Kubernetes and platform operations.** As detailed above, a private API server, internal container registry, and cluster-internal monitoring are all reachable through one tunnel, which is far cleaner than maintaining a forest of single-purpose forwards.
- **Break-glass and audited access.** Because everything funnels through one host, the bastion is the natural enforcement and logging point for emergency access, satisfying audit requirements that demand a single, observable path into sensitive systems.

In every one of these cases the legitimacy rests on the same foundation: you are authorized to log into the bastion, and the bastion is the sanctioned entry point. The technique extends your reach to what that host can already see; it does not, and should not, create access you were not granted.

## Cleaning Up and Managing Tunnels

Backgrounded tunnels are easy to forget. Find and stop them deliberately rather than leaving orphaned proxies open:

```bash
#!/usr/bin/env bash
# Find and stop a backgrounded SOCKS tunnel
pgrep -af 'ssh -D 1080' || true
pkill -f 'ssh -D 1080' || true
```

For tunnels you start and stop frequently, the systemd user service above is cleaner: `systemctl --user stop ssh-socks-bastion` is unambiguous and leaves no orphans. Make a habit of closing tunnels when you finish a task; a forgotten SOCKS proxy is both an attack-surface item and a source of confusing intermittent connectivity.

## Security Considerations and Legitimate Use

An SSH SOCKS proxy is a powerful primitive, and like all powerful primitives it deserves a clear security posture. The following practices keep it on the right side of the line.

- **Authorization is the whole foundation.** This technique is for hosts you are explicitly permitted to administer — bastions, jump hosts, and servers within your remit. It is a tool for *authorized* secure access to private resources, not for circumventing network controls. Treat the bastion as the audited entry point it is meant to be.
- **Use key-based authentication and protect the key.** Every tunnel is as trustworthy as the credential that opened it. Use modern keys (`ed25519`), protect them with a passphrase and an agent, and prefer short-lived certificates where your organization supports them. Tunnels that outlive their need are liability; tunnels opened with unprotected keys are worse.
- **Bind to loopback by default.** As covered above, binding the SOCKS listener to `0.0.0.0` turns your machine into an open relay into the internal network. Keep listeners on `127.0.0.1` unless there is a deliberate, controlled reason not to.
- **Lock down what the bastion can reach.** The proxy can connect to anything the bastion can route to. Apply least privilege on the bastion itself — security groups, host firewall rules, and network policies — so a tunnel cannot become an unrestricted gateway. Restrict forwarding on the server side with directives such as `PermitOpen` and `AllowTcpForwarding` in `sshd_config` when a host should only permit specific destinations.
- **Log and monitor bastion access.** Because all traffic funnels through the bastion, that host is the natural place to record who connected and when. Centralize its SSH logs and alert on anomalies. A bastion is valuable precisely because it concentrates access into something observable.
- **Close tunnels when you are done.** Long-lived background proxies accumulate risk. Use them for the duration of a task and tear them down, or manage them as supervised services with clear ownership.

### Hardening the Bastion in sshd_config

Most of the meaningful controls live on the server, not the client. A bastion that exists to broker tunnels should still be locked down so a compromised credential cannot turn it into an unrestricted relay. The following `sshd_config` fragment shows the directives that matter, applied narrowly to a tunnel-only group:

```text
# /etc/ssh/sshd_config — bastion hardening for controlled forwarding

# Keys only; no passwords, no keyboard-interactive
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no

# Default posture: deny forwarding to everyone
AllowTcpForwarding no
AllowAgentForwarding no
X11Forwarding no

# Carve out a group that is allowed to tunnel, and only to approved targets.
# PermitOpen whitelists the exact host:port pairs the SOCKS proxy may reach,
# so even a valid tunnel cannot connect to arbitrary internal services.
Match Group tunnelers
    AllowTcpForwarding yes
    PermitOpen 10.20.0.10:6443 db-private.corp.example.com:5432 registry.corp.internal:443
    # No shell: these accounts exist to forward, nothing else.
    ForceCommand /usr/sbin/nologin
```

Two directives do the heavy lifting. `AllowTcpForwarding yes` is scoped inside a `Match Group` block so only members of the `tunnelers` group can forward at all — everyone else gets the global `no`. `PermitOpen` then constrains *where* those tunnels may connect, turning an open SOCKS doorway into an allow-list of approved destinations; a client asking the proxy for anything not on the list is refused at the server. Pairing this with `ForceCommand /usr/sbin/nologin` yields accounts that can establish forwards but can never obtain an interactive shell, which is exactly the shape a dedicated bastion identity should have.

### Restricting Tunnels Per-Key

You can also constrain forwarding at the level of an individual key in `authorized_keys`, which is useful when a key belongs to an automated tunnel rather than a person:

```text
# ~/.ssh/authorized_keys on the bastion — a key that may ONLY forward, narrowly
restrict,permitopen="10.20.0.10:6443",port-forwarding ssh-ed25519 AAAA...key... svc-k8s-tunnel
```

The `restrict` option starts from "deny everything" and then `port-forwarding` plus `permitopen` re-enable exactly one capability against exactly one destination. A key carrying these options cannot open a shell, allocate a PTY, or forward anywhere except the listed API server — a tightly bounded credential well suited to a systemd-managed service tunnel.

Used this way, dynamic forwarding is a textbook fit for a defense-in-depth, least-exposure architecture: private subnets stay private, internal services keep no public footprint, and human access flows through a single hardened, audited host instead of a sprawl of point-to-point firewall exceptions.

## Conclusion

Dynamic port forwarding turns one SSH connection into a general-purpose, encrypted on-ramp to a private network — the difference between maintaining a forest of single-purpose `-L` forwards and running one `-D` tunnel that any SOCKS-aware tool can use. The mechanics are simple once the model is clear, and the operational payoff is large: secure browser access to internal apps, `kubectl` against a private API server, and reach to databases and registries that never touch the public internet.

Key takeaways:

- **`ssh -D` opens a SOCKS5 proxy**, not a fixed pipe — one tunnel, many destinations chosen per-connection by the client, which is what distinguishes it from local (`-L`) and remote (`-R`) forwarding.
- **Push DNS through the tunnel.** Use `socks5h://` in `curl`, "Proxy DNS when using SOCKS v5" in Firefox, and `proxy_dns` in proxychains so internal hostnames resolve on the bastion side. This is the most common setup mistake.
- **Make it reusable and resilient.** Define the tunnel once in `~/.ssh/config` with keepalives and `ExitOnForwardFailure yes`, then keep it alive with `autossh -M 0` or, better, a `Restart=always` systemd unit.
- **The same flags work everywhere** — Linux, macOS, native Windows OpenSSH — and PuTTY's **Dynamic** tunnel option is the GUI equivalent.
- **Reach private Kubernetes through the bastion** by exporting `HTTPS_PROXY=socks5://127.0.0.1:1080` for `kubectl`, or wrapping non-proxy-aware tools in `proxychains`.
- **Keep it authorized and least-exposure.** Bind to loopback, use protected keys, restrict forwarding on the server with `PermitOpen`/`AllowTcpForwarding`, log bastion access, and close tunnels when the work is done.
