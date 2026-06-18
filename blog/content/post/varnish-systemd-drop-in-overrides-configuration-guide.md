---
title: "Configuring Varnish Cache with systemd Drop-in Overrides: The Upgrade-Safe Way"
date: 2032-04-23T09:00:00-05:00
draft: false
tags: ["Varnish", "systemd", "Linux", "Caching", "HTTP", "Performance", "DevOps", "System Administration", "Web Server", "Kubernetes"]
categories:
- Linux
- Caching
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to configuring Varnish Cache through systemd drop-in overrides instead of editing the packaged unit file, covering ExecStart replacement, storage sizing, VCL paths, runtime parameters, and container alternatives."
more_link: "yes"
url: "/varnish-systemd-drop-in-overrides-configuration-guide/"
---

Editing the Varnish unit file that ships with your distribution package feels like the natural way to change the listen port or bump the cache size. It also guarantees that your next `apt upgrade` or `dnf update` silently reverts every change you made, often at the worst possible moment. The supported, upgrade-safe approach is a **systemd drop-in override**: a small fragment that systemd merges on top of the packaged unit without touching the original file. This guide walks through configuring Varnish Cache end to end with drop-ins, from clearing and resetting `ExecStart` to tuning runtime parameters, with an enterprise eye toward repeatability and change management.

<!--more-->

## Why Editing the Packaged Unit File Is a Trap

When you install Varnish from a distribution repository, the package places a unit file at a vendor-owned path. On Debian and Ubuntu this is typically `/lib/systemd/system/varnish.service`, and on RHEL-family systems it is `/usr/lib/systemd/system/varnish.service`. Both directories are managed by the package manager. They are not configuration directories, even though the files inside them look perfectly editable.

The problem is ownership. The package manager treats unit files under `/lib/systemd/system` and `/usr/lib/systemd/system` as **package-owned artifacts**. When a new version of the `varnish` package arrives, the package manager replaces those files with the maintainer's version. Any edit you made is gone. There is no merge, no conflict prompt for systemd units the way you sometimes get for files under `/etc`, and no warning in your monitoring that your carefully tuned 32 GB cache just reverted to the packaged default.

Consider the failure mode in an enterprise context. A team edits `/lib/systemd/system/varnish.service` to listen on port 80 and allocate a large malloc store. Six weeks later, an unattended-upgrades job pulls a security patch for Varnish. The unit file is overwritten, the service restarts on the packaged default port of 6081 with the default 256 MB cache, and the production site begins serving from an origin that was never sized to take full traffic. The fix is not "remember to re-edit the file." The fix is to never edit the package-owned file in the first place.

systemd was designed for exactly this situation. The override mechanism lets you layer your changes in a location that belongs to you, the administrator, under `/etc/systemd/system`. Files there always win over vendor files, and the package manager never touches them.

## How systemd Drop-in Overrides Work

A **drop-in override** is a `.conf` file placed in a directory named after the unit with a `.d` suffix. For the Varnish service, that directory is `/etc/systemd/system/varnish.service.d/`. Any `.conf` file inside it is parsed after the main unit and its directives are merged on top.

The merge rules are worth internalizing because they explain every quirk you will hit later:

- **Most directives are additive or last-wins per key.** Setting `MemoryMax=` in a drop-in simply overrides whatever the base unit declared.
- **Directives that accept a list append rather than replace.** `ExecStart`, `ExecStartPre`, `Environment`, and similar list-valued keys accumulate entries from every fragment unless you explicitly reset them.
- **Resetting a list requires an empty assignment first.** To replace `ExecStart` rather than add a second command, you write an empty `ExecStart=` line to clear the inherited value, then write the real one.

That last rule is the single most common stumbling block, and it is the reason a naive `ExecStart=` override produces a confusing `Service has more than one ExecStart= setting, which is only allowed for Type=oneshot services` error. The empty-line reset is mandatory, not stylistic.

You can create the override directory and file by hand, but the supported workflow uses a built-in helper.

## Creating the Override with systemctl edit

The `systemctl edit` command is the canonical way to author a drop-in. Running it for the Varnish unit opens your editor on a fresh override file and, on success, creates the `.d` directory and runs the equivalent of a daemon reload for you.

```bash
# Open (and create on first use) the drop-in override for the varnish unit.
# This writes to /etc/systemd/system/varnish.service.d/override.conf
sudo systemctl edit varnish
```

By default `systemctl edit` presents an empty fragment with helpful comments. If you would rather start from a full copy of the shipped unit so you can see exactly what you are overriding, use the full-unit variant. Be deliberate with this option: it copies the entire vendor unit into `/etc/systemd/system/varnish.service`, which shadows the package unit completely and means future packaged improvements to the unit are also ignored until you re-sync.

```bash
# Copy the entire vendor unit into /etc/ as a full override (use sparingly).
# Prefer the drop-in form above unless you truly need to replace the whole unit.
sudo systemctl edit --full varnish
```

For most deployments the drop-in form is correct. It keeps your changes small, auditable, and limited to exactly the directives you care about, while letting the distribution continue to own the boilerplate.

## Inspecting the Shipped Unit Before You Override

Before changing anything, look at what the package actually runs. You cannot override `ExecStart` sensibly without knowing the flags the maintainer already passes.

```bash
# Print the fully merged unit as systemd sees it, with the source file
# of each section annotated in the output as comments.
systemctl cat varnish
```

A typical Debian or Ubuntu `varnish.service` `[Service]` section looks similar to the following. Your exact flags will vary by distribution and Varnish version, so always confirm with `systemctl cat` rather than copying blindly.

```ini
# Excerpt from the packaged /lib/systemd/system/varnish.service
[Service]
Type=forking
KillMode=process

# The shipped ExecStart: listen on 6081, admin CLI on 127.0.0.1:6082,
# default VCL, secret file, and a 256 MB malloc cache.
ExecStart=/usr/sbin/varnishd \
    -a :6081 \
    -T localhost:6082 \
    -f /etc/varnish/default.vcl \
    -S /etc/varnish/secret \
    -s malloc,256m

ExecReload=/usr/share/varnish/varnishreload
LimitNOFILE=131072
LimitMEMLOCK=85983232
```

The flags map directly to Varnish behavior:

- `-a :6081` sets the **listen address and port** for client traffic.
- `-T localhost:6082` exposes the **management CLI** on a TCP socket.
- `-f /etc/varnish/default.vcl` points to the **VCL configuration file**.
- `-S /etc/varnish/secret` is the shared secret that authenticates CLI access.
- `-s malloc,256m` selects the **storage backend** and its size.

Your override will reset this entire `ExecStart` and supply a production-appropriate version.

## Full Anatomy of the Packaged varnish.service Unit

Overriding a unit well means understanding every section the maintainer ships, not just `ExecStart`. The fragments you write inherit everything you do not explicitly change, so a directive you ignore is a directive you have implicitly accepted. Here is a representative full unit, annotated section by section. Confirm the specifics against your own `systemctl cat varnish` output, because Debian, Ubuntu, RHEL, and the official varnish-cache.org packages differ in detail.

```ini
# Representative packaged varnish.service (annotated). Confirm your own
# copy with: systemctl cat varnish
[Unit]
Description=Varnish Cache, a high-performance HTTP accelerator
Documentation=https://www.varnish-cache.org/docs/ man:varnishd
# Order Varnish after the network is fully configured, not merely up.
After=network-online.target nss-lookup.target
Wants=network-online.target

[Service]
# 'forking' tells systemd to expect the process to daemonize and exit the
# parent. Modern practice runs varnishd in foreground (-F) with Type=simple.
Type=forking

# KillMode=process kills only the master, leaving worker children to the
# master's own shutdown logic. Important: do NOT switch this to control-group
# casually, since varnishd manages its own child reaping.
KillMode=process

# The command that actually starts the cache. Everything you tune lives here.
ExecStart=/usr/sbin/varnishd \
    -a :6081 \
    -T localhost:6082 \
    -f /etc/varnish/default.vcl \
    -S /etc/varnish/secret \
    -s malloc,256m

# Graceful reload helper shipped by the distribution. Loads new VCL and
# switches to it without dropping the cache. Wired to 'systemctl reload'.
ExecReload=/usr/share/varnish/varnishreload

# Open-file-descriptor ceiling. Varnish opens two fds per client and per
# backend connection; a busy cache exhausts the default 1024 instantly.
LimitNOFILE=131072

# Locked memory limit. The jemalloc allocator and the shared-memory log
# (VSM) need to lock pages. Too low a value causes startup failures.
LimitMEMLOCK=85983232

[Install]
WantedBy=multi-user.target
```

The directives most likely to bite you are the ones that look like boilerplate:

- `Type=forking` is the legacy default. If your override adds `-F` without also setting `Type=simple`, systemd waits for a daemonization that never happens and times the unit out as failed. This single mismatch is the most common upgrade-era Varnish incident.
- `LimitNOFILE` and `LimitMEMLOCK` are sized for the packaged 256 MB cache. A 16 GB or 64 GB malloc store needs far more locked memory; leaving the packaged `LimitMEMLOCK` in place can prevent a large cache from starting with a `mlock` error buried in the journal.
- `After=network-online.target` matters when Varnish binds a specific non-wildcard address. If it starts before the address exists, the bind fails. The packaged ordering usually handles this, but custom `-a 10.0.0.5:80` listeners are a frequent regression when administrators copy a unit to a host whose interface comes up late.

Knowing which of these you intend to change, and which you intend to inherit unchanged, is the entire discipline of writing a good drop-in.

## Resetting and Replacing ExecStart

This is the core of the configuration. Inside the editor opened by `systemctl edit varnish`, add a `[Service]` section that first clears the inherited `ExecStart` and then defines a new one. The empty `ExecStart=` line is the reset; without it systemd appends and refuses to start.

```ini
# /etc/systemd/system/varnish.service.d/override.conf
[Service]
# Clear the ExecStart inherited from the packaged unit. This empty
# assignment is REQUIRED before defining a replacement, otherwise
# systemd treats both lines as additional commands and refuses to start.
ExecStart=

# Define the production ExecStart. Run in the foreground (-F) so systemd
# supervises the process directly; use Type=simple to match (see below).
ExecStart=/usr/sbin/varnishd \
    -F \
    -a :80 \
    -a :8443,PROXY \
    -T localhost:6082 \
    -f /etc/varnish/default.vcl \
    -S /etc/varnish/secret \
    -s malloc,16g \
    -p thread_pool_min=200 \
    -p thread_pool_max=4000 \
    -p workspace_client=128k \
    -p feature=+http2

# Match the supervision model to the -F flag. The packaged unit may use
# Type=forking; foreground varnishd should be Type=simple.
Type=simple
```

Several decisions in this block deserve explanation.

The `-F` flag runs `varnishd` in the foreground so systemd can supervise the master process directly instead of tracking a forked daemon. When you use `-F`, set `Type=simple` so systemd considers the service started as soon as the process is launched. If you leave the packaged `Type=forking` in place while running with `-F`, systemd waits for a fork that never comes and eventually marks the unit failed. This pairing of `Type=simple` with `-F` is the most reliable modern configuration.

The two `-a` flags demonstrate that **multiple listeners are themselves additive at the varnishd level**, not the systemd level. Here Varnish listens on port 80 for plain HTTP and on port 8443 expecting the PROXY protocol, which is the standard pattern when a TLS terminator such as Hitch or an ingress proxy sits in front of Varnish and forwards the original client address.

## Choosing a Storage Backend: malloc vs file

The `-s` flag selects the cache storage stevedore, and the choice has direct operational consequences.

**malloc storage** keeps the entire cache in process memory, backed by anonymous mappings the kernel may swap. It is the recommended default for almost all deployments because it is simple and fast, and because the kernel page cache already handles the hard parts of memory management. Size it to the working set you want resident, leaving headroom for Varnish overhead and the operating system.

```ini
# Memory-backed cache sized to 16 GB. Best general-purpose choice.
# Account for roughly 1 KB of overhead per object on top of this figure.
ExecStart=/usr/sbin/varnishd ... -s malloc,16g
```

**file storage** maps a single large file and lets the OS page cache mediate between RAM and disk. Historically it was used for caches larger than available RAM, but it suffers badly from fragmentation over long uptimes and is widely discouraged for new deployments. If you genuinely need an on-disk cache that exceeds memory, evaluate the **Massive Storage Engine (MSE)** available in Varnish Enterprise rather than the open-source `file` stevedore.

```ini
# Disk-backed cache. Generally discouraged due to fragmentation; shown
# for completeness. Prefer malloc, or MSE on Varnish Enterprise.
ExecStart=/usr/sbin/varnishd ... -s file,/var/lib/varnish/storage.bin,200g
```

### Sizing malloc Honestly

The number you pass to `-s malloc,N` is the size of the object storage arena, not the total resident size of the process. Varnish carries overhead that you must budget for separately, or the box will swap exactly when traffic peaks:

- **Per-object overhead.** Each cached object costs roughly 1 KB of structures (the object core, its headers, and bookkeeping) on top of the body bytes. A cache holding ten million small objects therefore consumes about 10 GB of overhead before counting a single byte of payload. Header-heavy APIs push this higher.
- **Transient storage.** Uncacheable and streaming responses use a separate `Transient` store. If you do not declare one explicitly, Varnish creates an unbounded malloc `Transient`, which can grow without limit under a flood of `hit-for-miss` traffic and trigger the OOM killer. Bound it explicitly on busy systems.
- **Workspaces and threads.** Each worker thread reserves stack plus the client and backend workspaces you configured with `-p`. Eight thousand threads at 128 KB of client workspace alone is roughly 1 GB that has nothing to do with `-s malloc`.

A defensible layout for a dedicated 32 GB cache node is something like: 22 GB malloc object store, a bounded 2 GB transient, and the remaining 8 GB left for thread workspaces, the operating system, a TLS terminator, and monitoring agents.

```ini
# Main object store plus an explicitly bounded transient store. Bounding
# Transient prevents uncacheable-traffic floods from exhausting RAM.
ExecStart=/usr/sbin/varnishd ... \
    -s malloc,22g \
    -s Transient=malloc,2g
```

A practical rule: pick a malloc size that fits comfortably in RAM after subtracting the operating system, any TLS terminator, monitoring agents, transient storage, and worst-case thread workspaces. On a dedicated 24 GB cache node, a 16 GB malloc store leaves sane headroom. Over-allocating malloc and letting the box swap turns a fast cache into a latency generator: page faults on the hot set defeat the entire purpose of an in-memory accelerator.

You can also declare multiple named stevedores and route objects to them from VCL, which is useful for separating large media objects from small API responses.

```ini
# Two named stores: a small fast tier and a larger general tier.
# VCL can target them with set beresp.storage = storage.fast;
ExecStart=/usr/sbin/varnishd ... \
    -s fast=malloc,2g \
    -s main=malloc,14g
```

## Pointing at the VCL File and Validating It

The `-f` flag sets the path to your **VCL** (Varnish Configuration Language) file, where all caching policy lives. Keeping the path explicit in the override means the policy file location is part of your reviewed configuration rather than an inherited default.

```ini
# Explicit VCL path in the override keeps policy location under review.
ExecStart=/usr/sbin/varnishd ... -f /etc/varnish/default.vcl
```

Never restart Varnish to discover whether your VCL compiles. A syntax error in VCL will prevent the service from starting at all, which during an upgrade window means an outage. Compile-test first with the `-C` flag, which compiles the VCL and prints the generated C without launching the cache.

```bash
# Compile-check the VCL without starting Varnish. Exits non-zero and prints
# the error location if compilation fails. Discard stdout; we only care
# about the exit status and any stderr diagnostics.
sudo varnishd -C -f /etc/varnish/default.vcl >/dev/null
echo "VCL compile exit status: $?"
```

For a running instance, prefer a **graceful VCL reload** over a restart. A restart discards the entire cache and forces a cold start against your origin. The packaged unit wires an `ExecReload` to the distribution's `varnishreload` helper, which loads and activates new VCL without dropping cached objects.

```bash
# Reload VCL without flushing the cache or interrupting service.
# This runs the unit's ExecReload (varnishreload), not a process restart.
sudo systemctl reload varnish
```

## Tuning Runtime Parameters

The `-p` flag sets **runtime parameters** that control thread pools, workspaces, protocol features, and grace behavior. Each `-p` sets one parameter, so a tuned deployment carries several. Setting them in the unit means they are applied deterministically at boot rather than via a manual CLI session that disappears on the next restart.

```ini
# Runtime parameter tuning placed in the override ExecStart.
ExecStart=/usr/sbin/varnishd ... \
    -p thread_pool_min=200 \
    -p thread_pool_max=4000 \
    -p thread_pools=2 \
    -p workspace_client=128k \
    -p workspace_backend=128k \
    -p http_resp_hdr_len=8k \
    -p http_resp_size=64k \
    -p default_grace=60 \
    -p feature=+http2
```

The parameters worth knowing for production sizing:

- `thread_pool_min` and `thread_pool_max` bound the worker threads **per pool**. The effective maximum is `thread_pools` multiplied by `thread_pool_max`, so with two pools and a max of 4000 you allow up to 8000 worker threads.
- `thread_pools` sets the number of independent pools; two is a reasonable default and matching it to socket count rather than core count is the modern guidance.
- `workspace_client` and `workspace_backend` size the per-transaction memory workspaces. Header-heavy applications, especially those with large cookies or many custom headers, need these raised above the defaults to avoid `503` workspace-overflow errors.
- `http_resp_hdr_len` and `http_resp_size` cap response header line length and total header size; raise them when an upstream emits unusually large headers.
- `default_grace` controls how long Varnish may serve **stale-while-revalidate** content, smoothing origin latency spikes.
- `feature=+http2` enables HTTP/2 on the listeners.

Runtime parameters can also be changed live through the CLI for experimentation, but anything you want to persist belongs in the override.

```bash
# Inspect a live parameter and its documented bounds via the CLI.
sudo varnishadm param.show thread_pool_max

# Temporarily change a parameter at runtime (does NOT persist a restart).
# Persist the value by adding -p thread_pool_max=... to the override instead.
sudo varnishadm param.set thread_pool_max 5000
```

## Controlling TTL and Grace at the Daemon Level

Caching lifetime is primarily a VCL and origin-headers concern, but two `-p` parameters set the *defaults* that apply when neither the backend nor your VCL says otherwise. Setting them in the override makes the fleet-wide baseline explicit instead of relying on a compiled-in default that can change between Varnish versions.

```ini
# Daemon-level cache lifetime defaults. VCL and Cache-Control still win
# when present; these only fill the gaps.
ExecStart=/usr/sbin/varnishd ... \
    -p default_ttl=120 \
    -p default_grace=60 \
    -p default_keep=600
```

- `default_ttl` is how long an object is considered fresh when the origin sends no explicit freshness headers. The packaged default of 120 seconds is conservative; raise it only if you trust your invalidation path.
- `default_grace` is the window during which Varnish may serve a stale object while it asynchronously revalidates with the origin. This is the **stale-while-revalidate** behavior that shields your origin from latency spikes and brief outages. A grace of 60 seconds means a backend can be slow or down for a minute without clients seeing an error.
- `default_keep` extends how long an expired, out-of-grace object is retained on disk or in memory so that a conditional request (`If-Modified-Since` / `If-None-Match`) can still produce a cheap `304 Not Modified` revalidation instead of a full fetch.

The interplay matters: total object retention is `ttl + grace + keep`. An object lives fresh for `ttl`, serveable-but-stale for the next `grace`, and revalidatable-only for the final `keep`. Sizing these too short turns every micro-outage into an origin stampede; sizing them too long risks serving stale content past acceptable bounds. Tune them against your invalidation strategy, not in isolation.

## Managing the Secret File and the Jail

Two security-relevant flags travel with every `varnishd` invocation, and both deserve deliberate handling in the override rather than blind inheritance.

The `-S` flag points to the **secret file** that authenticates connections to the management CLI exposed by `-T`. Anyone who can read this file and reach the CLI port can load arbitrary VCL, which is effectively remote code execution against your cache. Treat it accordingly:

```bash
# The secret file must be readable only by root (or the management user).
# A world-readable secret plus an exposed -T port is a critical exposure.
sudo install -o root -g root -m 0600 /dev/stdin /etc/varnish/secret <<'EOF'
# Replace with a high-entropy value, e.g. the output of:
#   head -c32 /dev/urandom | base64
EOF
sudo ls -l /etc/varnish/secret
```

Keep the management CLI bound to loopback (`-T localhost:6082`) unless you have a concrete reason to expose it, and if you must expose it, restrict it with a host firewall. There is no authentication beyond the shared secret.

The `-j` flag selects the **jail**, the privilege-separation mechanism Varnish uses to drop from root after binding privileged ports. On Linux the default is the `unix` jail, which drops to the `varnish` (worker) and `vcache` (cache) users. Setting it explicitly documents intent and lets you pin the unprivileged accounts:

```ini
# Explicit unix jail with named unprivileged users. varnishd binds the
# privileged port as root, then drops to these accounts for worker and
# cache processes. Naming them avoids surprises if package defaults change.
ExecStart=/usr/sbin/varnishd ... \
    -j unix,user=varnish,ccgroup=varnish
```

Because the worker drops privileges, the user it lands on must be able to read the VCL file and write the shared-memory log directory under `/var/lib/varnish`. When you relocate either path in your override, fix the ownership at the same time, or the cache fails to start with a permissions error that looks unrelated to your change.

## Applying and Verifying the Configuration

After saving the override, systemd needs to reload its internal state and the service needs to pick up the new `ExecStart`. If you used `systemctl edit`, the daemon reload is performed for you, but running it explicitly is harmless and is required if you created the file by hand.

```bash
# Reload systemd's view of unit files after editing the drop-in.
sudo systemctl daemon-reload

# Restart Varnish to apply a changed ExecStart. Note: this flushes the
# cache. Use 'reload' instead when only VCL changed.
sudo systemctl restart varnish
```

Verification is not optional in production. Confirm that the merged unit is what you intended before declaring success. The `systemctl cat` command shows every fragment that contributes to the final unit, annotated with its source path.

```bash
# Show the merged unit. The output lists each source file as a comment,
# so you can confirm the drop-in is layered on top of the vendor unit.
systemctl cat varnish
```

For a focused check on just the command line that systemd will execute, query the resolved `ExecStart` property directly. This is the authoritative answer to "what flags is Varnish actually running with."

```bash
# Print only the resolved ExecStart property. This reflects the merged
# value after the drop-in reset and replacement have been applied.
systemctl show varnish --property=ExecStart
```

Finally, confirm the process and its listeners at the OS level rather than trusting the unit alone.

```bash
# Verify the running command line matches the override.
ps -o args= -C varnishd

# Confirm Varnish is listening on the expected ports.
sudo ss -ltnp | grep varnishd
```

If `systemctl show` reports the old flags, the most common causes are a forgotten `daemon-reload`, a `.conf` file with the wrong name or extension, or a missing empty `ExecStart=` reset line that left both commands in place. Re-run `systemctl cat` and look for two `ExecStart` entries as the smoking gun.

## Restart vs Reload and Zero-Downtime VCL Changes

The single most important operational distinction with Varnish is the difference between a **restart** and a **reload**, because confusing them is how a routine config push becomes an origin overload.

A `systemctl restart varnish` stops the daemon and starts it fresh. That means the entire in-memory cache is discarded. The newly started instance begins with a cold cache and forwards every request to the origin until the working set repopulates. On a high-traffic site this cold-start thundering herd can knock over an origin that was perfectly healthy a second earlier. You should only restart when you have changed something the daemon can only read at startup: the `ExecStart` flags, the storage configuration, listen addresses, or jail settings.

A `systemctl reload varnish` runs the unit's `ExecReload`, which on packaged installs is the distribution's `varnishreload` helper. It loads the new VCL, activates it, and discards the old VCL only after the switch, all without dropping a single cached object or interrupting in-flight requests. This is the correct tool for any change that lives in VCL: backend definitions, caching rules, header manipulation, ACLs, and routing.

```bash
# VCL-only change: graceful, keeps the cache warm, no origin stampede.
sudo systemctl reload varnish

# Flag/storage/listener change: cold restart, flushes the cache. Schedule
# these and expect an origin traffic spike as the cache repopulates.
sudo systemctl restart varnish
```

### Reloading VCL Directly with varnishadm

The `varnishreload` helper is a convenience wrapper around the Varnish CLI. Understanding the underlying `varnishadm` calls is valuable when you need finer control, want to stage VCL before activating it, or need to roll back to a previous policy instantly.

VCL in Varnish is versioned: every loaded configuration has a label, several can be resident at once, and exactly one is active. You compile and load a new version, switch the active pointer to it, and the old version stays resident until you discard it. Rolling back is just pointing the active label at the previous version, which is effectively instantaneous because nothing recompiles.

```bash
# Load a new VCL under an explicit, dated label. This compiles it inside
# the running daemon; a compile error fails here and the live config is
# untouched, so a bad VCL never takes the cache down.
sudo varnishadm vcl.load policy_2032_04_23 /etc/varnish/default.vcl

# Activate the freshly loaded label. The switch is atomic; in-flight
# requests finish on the old VCL, new requests use the new one.
sudo varnishadm vcl.use policy_2032_04_23

# List all resident VCLs and see which one is active.
sudo varnishadm vcl.list

# Instant rollback: point 'active' back at the previously good label.
# No recompile, no cache flush, no restart.
sudo varnishadm vcl.use policy_2032_04_22

# Once you are confident, discard the retired VCL to free its resources.
sudo varnishadm vcl.discard policy_2032_04_22
```

This load-then-use pattern is the backbone of safe VCL deployment in an enterprise pipeline: your CI compiles the VCL with `varnishd -C`, your deploy step runs `vcl.load` under a build-tagged label, and a separate promotion step runs `vcl.use`. Rollback is a one-line `vcl.use` of the last-known-good label, with no service interruption.

## Integrating with journald and the Varnish Shared Log

Varnish has an unusual logging model that surprises administrators expecting an access log file like nginx or Apache. The daemon writes nothing to disk by default. Instead it records every transaction to a circular **shared memory log** (the VSM/VSL), and separate utilities tail that ring buffer to produce human-readable output. This keeps the hot path fast, but it means your logging strategy is split between two channels.

The first channel is the daemon's own lifecycle and error output. Because the override runs `varnishd` with `-F` under `Type=simple`, systemd captures its stdout and stderr straight into the journal with no extra configuration. Startup banners, VCL load failures, and `mlock` errors all land in `journalctl`.

```bash
# Daemon lifecycle, startup, and error messages for the unit.
sudo journalctl -u varnish --no-pager -n 100

# Follow live; invaluable while applying an override and watching for a
# failed start caused by a bad flag or insufficient LimitMEMLOCK.
sudo journalctl -u varnish -f
```

The second channel is request-level access logging, which comes from the companion daemons `varnishncsa` (Apache/NCSA combined format) and `varnishlog` (the full transaction detail). On packaged installs these ship as their own units. Enabling `varnishncsa` gives you an access log; pointing it at the journal or a file is a policy choice.

```bash
# Enable and start the NCSA-format access logger as its own service.
# It reads the shared memory log and emits combined-format access lines.
sudo systemctl enable --now varnishncsa

# Ad-hoc full-detail transaction trace for one request type, no daemon
# needed. Here: only requests that resulted in a backend fetch (a miss).
sudo varnishlog -g request -q 'VCL_call eq "BACKEND_FETCH"'

# Tail access logs centrally via the journal if varnishncsa logs to stdout
# under systemd (configure its unit with an override the same way).
sudo journalctl -u varnishncsa -f
```

For centralized logging, the cleanest pattern is to let both `varnish` and `varnishncsa` log to the journal under systemd and ship the journal with your existing collector (`systemd-journal-remote`, Vector, Fluent Bit, or the Promtail/Loki stack). That keeps a single log pipeline rather than scraping a separate access-log file, and it survives package upgrades for the same reason your drop-in does: the logging wiring lives in `/etc`, not in a package-owned unit.

## Common Pitfalls

A handful of failure modes account for nearly every Varnish-via-systemd support ticket. Knowing them shortens debugging from hours to minutes.

**The override does not take effect.** You edited the drop-in, restarted, and `systemctl show` still reports the old `ExecStart`. The causes, in order of frequency: you forgot `systemctl daemon-reload` after editing the file by hand; the file is not named `*.conf` (systemd ignores any other extension in a `.d` directory); the file is in the wrong directory, often `/etc/systemd/system/varnish.d/` with the missing `.service` in the directory name; or you edited the package unit under `/lib` and a different drop-in under `/etc` is winning. Always confirm with `systemctl cat varnish`, which prints the source path of every contributing fragment.

**The multiple-ExecStart error.** Starting the service produces `Service has more than one ExecStart= setting, which is only allowed for Type=oneshot services`. This is the missing empty-reset line. A drop-in `ExecStart=/usr/sbin/varnishd ...` *adds* to the inherited command rather than replacing it. You must write a bare `ExecStart=` line first to clear the list, then your real command:

```ini
[Service]
# WRONG: this appends a second ExecStart and triggers the error.
# ExecStart=/usr/sbin/varnishd -a :80 ...

# RIGHT: empty reset first, then the replacement.
ExecStart=
ExecStart=/usr/sbin/varnishd -a :80 -f /etc/varnish/default.vcl -s malloc,4g
```

**Type mismatch hangs the start.** You added `-F` but left `Type=forking`. systemd waits for a daemonization that foreground `varnishd` will never perform, then times out and marks the unit failed after `TimeoutStartSec`. Pair `-F` with `Type=simple`, always.

**Cache too large to start.** A big `-s malloc` plus the packaged `LimitMEMLOCK` fails at startup with an `mlock` or memory-lock error in the journal. Raise `LimitMEMLOCK=infinity` (or a generous explicit value) in the same override.

**Listener bind fails on boot but works manually.** A non-wildcard `-a 10.0.0.5:80` listener fails because the interface address is not yet configured when Varnish starts. Ensure `After=network-online.target` and `Wants=network-online.target` are present; add them in your drop-in's `[Unit]` section if the packaged unit lacks them.

**VCL change appears ignored.** You edited `default.vcl` and ran `systemctl restart`, but behavior did not change, or worse, the restart flushed the cache and caused an origin spike. If a restart "did nothing," you likely edited a file that the running `-f` flag does not point to. Confirm the active path with `systemctl show varnish --property=ExecStart`, then use `systemctl reload` (or `varnishadm vcl.use`) rather than restart for VCL changes.

## Troubleshooting Checklist

When Varnish will not start or will not behave after an override change, work through these in order. Each step narrows the fault domain.

```bash
# 1. Is the merged unit what you think it is? Look for two ExecStart lines
#    (reset bug) and confirm the drop-in path appears as a source.
systemctl cat varnish

# 2. What command will systemd actually run? This is authoritative.
systemctl show varnish --property=ExecStart --property=Type

# 3. Why did the last start fail? Read the journal for the unit.
sudo journalctl -u varnish -n 80 --no-pager

# 4. Does the VCL even compile? A bad VCL blocks startup entirely.
sudo varnishd -C -f /etc/varnish/default.vcl >/dev/null && echo "VCL OK"

# 5. Is anything already bound to the port you configured?
sudo ss -ltnp '( sport = :80 )'

# 6. Can the unprivileged worker read the VCL and write its work dir?
sudo -u varnish test -r /etc/varnish/default.vcl && echo "VCL readable by worker"
ls -ld /var/lib/varnish

# 7. Did you reload systemd after a hand edit?
sudo systemctl daemon-reload && sudo systemctl restart varnish
```

If all seven pass and the service still misbehaves, the problem is almost certainly in VCL logic or origin behavior rather than the systemd layer, and `varnishlog -g request` on a failing request is the next tool to reach for.

## A Complete, Reviewable Override

Pulling the pieces together, here is a single override file suitable for a dedicated cache node fronted by a separate TLS terminator. Treat it as a starting point and tune the numbers to your hardware and traffic.

```ini
# /etc/systemd/system/varnish.service.d/override.conf
#
# Upgrade-safe Varnish configuration. This drop-in layers on top of the
# distribution-packaged varnish.service and survives package upgrades.

[Service]
# Required reset before redefining a list-valued directive.
ExecStart=

# Foreground varnishd supervised directly by systemd.
ExecStart=/usr/sbin/varnishd \
    -F \
    -a :80 \
    -a :8443,PROXY \
    -T localhost:6082 \
    -f /etc/varnish/default.vcl \
    -S /etc/varnish/secret \
    -s malloc,16g \
    -p thread_pools=2 \
    -p thread_pool_min=200 \
    -p thread_pool_max=4000 \
    -p workspace_client=128k \
    -p workspace_backend=128k \
    -p default_grace=60 \
    -p feature=+http2

# Foreground process => simple supervision.
Type=simple

# Raise file descriptor and locked-memory limits to match a large cache.
LimitNOFILE=131072
LimitMEMLOCK=infinity

# Restart on failure so a transient crash does not become an outage.
Restart=on-failure
RestartSec=2s
```

Because this lives entirely under `/etc`, you can and should commit it to your configuration management system. In an Ansible or Puppet workflow, template this file, then notify a handler that runs `systemctl daemon-reload` followed by `systemctl restart varnish`. The change is now reviewable in version control, reproducible across the fleet, and immune to package upgrades.

## When to Skip systemd Entirely: Varnish in Containers

systemd drop-ins are the right tool when Varnish runs directly on a host or VM. In a containerized or Kubernetes environment, the calculus changes. There is no systemd inside a typical container; the container runtime is the supervisor, and the equivalent of `ExecStart` is the image entrypoint and command.

Running Varnish in a container moves all of the configuration we discussed into the image and the orchestration manifests:

- The `varnishd` flags that lived in `ExecStart` become the container's `command`/`args`.
- The VCL file is mounted as a `ConfigMap` rather than living at `/etc/varnish/default.vcl` on the host.
- Storage sizing must respect the container's memory limit; a malloc store larger than the cgroup limit invites the OOM killer.

A minimal container invocation looks like this, and the parallels to the systemd `ExecStart` are intentional.

```yaml
# Kubernetes container spec excerpt running Varnish without systemd.
# The args here are the direct analog of the systemd ExecStart override.
apiVersion: v1
kind: Pod
metadata:
  name: varnish
spec:
  containers:
    - name: varnish
      image: varnish:7.5
      args:
        - "-F"                          # foreground; the runtime supervises
        - "-a"
        - ":80"                         # client listener
        - "-f"
        - "/etc/varnish/default.vcl"    # VCL mounted from a ConfigMap
        - "-s"
        - "malloc,1g"                   # keep below the memory limit
      ports:
        - containerPort: 80
      resources:
        limits:
          memory: "1536Mi"              # leave headroom above the 1g store
      volumeMounts:
        - name: vcl
          mountPath: /etc/varnish
  volumes:
    - name: vcl
      configMap:
        name: varnish-vcl
```

### A Production-Shaped Kubernetes Deployment

The minimal Pod above shows the analogy; a production deployment adds the pieces that systemd gave you for free on a host: health probes (the orchestrator's equivalent of `Restart=on-failure`), a memory limit that honestly reflects the malloc store plus overhead, and a graceful reload path. Varnish has no built-in HTTP health endpoint, so the standard pattern is to define a tiny synthetic responder in VCL and probe it.

```yaml
# Production-shaped Varnish Deployment. The args mirror the systemd
# ExecStart; probes replace Restart=; the ConfigMap replaces /etc/varnish.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: varnish
  labels:
    app: varnish
spec:
  replicas: 3
  selector:
    matchLabels:
      app: varnish
  template:
    metadata:
      labels:
        app: varnish
    spec:
      containers:
        - name: varnish
          image: varnish:7.5
          args:
            - "-F"                          # foreground; runtime supervises
            - "-a"
            - ":80"                         # client listener
            - "-f"
            - "/etc/varnish/default.vcl"    # VCL from the ConfigMap
            - "-s"
            - "malloc,1g"                   # MUST stay under the cgroup limit
            - "-p"
            - "default_grace=60"            # stale-while-revalidate
          ports:
            - name: http
              containerPort: 80
          resources:
            requests:
              memory: "1280Mi"
              cpu: "500m"
            limits:
              memory: "1536Mi"              # headroom above the 1g store
          # Liveness: restart the pod if Varnish stops answering. Probes
          # a synthetic /healthz handler defined in VCL (return(synth)).
          livenessProbe:
            httpGet:
              path: /healthz
              port: http
            initialDelaySeconds: 10
            periodSeconds: 10
            failureThreshold: 3
          # Readiness: only send traffic once Varnish answers, so a rolling
          # update never routes to a cold or still-starting pod.
          readinessProbe:
            httpGet:
              path: /healthz
              port: http
            initialDelaySeconds: 5
            periodSeconds: 5
          volumeMounts:
            - name: vcl
              mountPath: /etc/varnish
              readOnly: true
      volumes:
        - name: vcl
          configMap:
            name: varnish-vcl
```

The matching VCL gives the probe something cheap to hit without touching the origin:

```vcl
vcl 4.1;

# Synthetic health endpoint so Kubernetes probes never hit a backend.
sub vcl_recv {
    if (req.url == "/healthz") {
        return (synth(200, "OK"));
    }
}

sub vcl_synth {
    if (resp.status == 200 && req.url == "/healthz") {
        set resp.http.Content-Type = "text/plain";
        synthetic("OK");
        return (deliver);
    }
}
```

A few container-specific cautions that have no host equivalent:

- **The memory limit is the real cache ceiling.** A `-s malloc,1g` store inside a 1536Mi-limited container is fine; the same store inside a 1Gi-limited container will be OOM-killed the moment workspaces and transient storage push the process past the cgroup limit. Always set the malloc size well below `resources.limits.memory`.
- **Reloads work differently.** There is no `systemctl reload`. To change VCL, update the ConfigMap and either trigger a rolling restart (cold caches, but each replica warms while others serve) or `kubectl exec` into each pod and run `varnishadm vcl.load`/`vcl.use` for a warm reload. Mature setups run a sidecar or operator that watches the ConfigMap and issues the `varnishadm` calls.
- **ConfigMap propagation is not instant.** A mounted ConfigMap update can take up to a minute to appear in the pod, and Varnish will not notice the file changed on its own. Whatever reload mechanism you use must be triggered explicitly after the file lands.

The key insight is that the *concepts* are identical across both worlds. Whether the supervisor is systemd or a container runtime, you are still choosing a listen port, a VCL path, a storage backend and size, and a set of runtime parameters. The mapping is direct:

- `ExecStart` flags become container `args`.
- `/etc/varnish/default.vcl` on disk becomes a ConfigMap-mounted file.
- `Restart=on-failure` becomes a `livenessProbe`.
- `LimitMEMLOCK`/`LimitNOFILE` become container `securityContext`/ulimit and node-level settings.
- `systemctl reload` becomes a ConfigMap update plus an explicit `varnishadm vcl.use`.

The drop-in override is simply the host-native way to express that intent, while the container manifest is the orchestrated way. Choose based on where Varnish runs, not on preference, and keep the storage size honest against whatever memory limit governs the process.

## Conclusion

Configuring Varnish through systemd drop-in overrides is the difference between a cache that survives package upgrades and one that silently reverts to defaults during a maintenance window. The mechanism is small but precise, and the precision is what protects you.

Key takeaways:

- **Never edit the package-owned unit** at `/lib/systemd/system/varnish.service`; package upgrades overwrite it without warning.
- **Use `systemctl edit varnish`** to author a drop-in at `/etc/systemd/system/varnish.service.d/override.conf` that systemd merges on top of the vendor unit.
- **Reset `ExecStart` with an empty assignment first**, then define your replacement; skipping the reset produces a multiple-`ExecStart` failure.
- **Pair `-F` with `Type=simple`** so systemd supervises the foreground `varnishd` process correctly.
- **Prefer `malloc` storage** sized to fit in RAM with headroom; treat the `file` stevedore as a last resort and evaluate MSE for large on-disk caches.
- **Compile-check VCL with `varnishd -C`** before applying, and use `systemctl reload varnish` for graceful VCL changes that preserve the cache.
- **Persist runtime parameters with `-p` in the override** rather than via ephemeral CLI changes that vanish on restart.
- **Always verify with `systemctl cat` and `systemctl show --property=ExecStart`** after `daemon-reload`, and confirm listeners with `ss`.
- **Inherit the rest of the unit deliberately**: raise `LimitMEMLOCK` for large caches, keep `After=network-online.target` for non-wildcard listeners, and know that ignoring a packaged directive means accepting it.
- **Reload, do not restart, for VCL changes**: a restart flushes the cache and risks an origin stampede, while `systemctl reload` (or `varnishadm vcl.load`/`vcl.use`) swaps policy with the cache warm and rolls back instantly.
- **Bound transient storage and account for overhead**: budget per-object structures, thread workspaces, and the `Transient` store separately from the `-s malloc` figure so the box never swaps under load.
- **Protect the management plane**: keep the `-S` secret file `0600`, bind `-T` to loopback, and set the jail explicitly so privilege drop and file ownership are intentional.
- **Send Varnish logs through the journal**: with `-F` under `Type=simple`, daemon output lands in `journalctl`, and `varnishncsa` provides access logs you can ship with the rest of your fleet.
- **In containers and Kubernetes, drop the systemd layer entirely**: the same flags become the entrypoint args, VCL becomes a ConfigMap, `Restart=` becomes a liveness probe with a synthetic `/healthz` handler, and storage size must respect the cgroup memory limit.
