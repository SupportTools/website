---
title: "docker system prune -a --volumes: What It Deletes and How to Run It Safely"
date: 2026-10-27T09:00:00-05:00
draft: false
tags: ["Docker", "Containers", "Storage", "DevOps", "Troubleshooting", "System Administration"]
categories:
- Docker
- Containers
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Exactly what docker system prune -a --volumes removes, why named volumes survive it since Docker 23, how to preview reclaimable space, and how to filter, protect and script pruning safely."
more_link: "yes"
url: "/docker-system-prune-a-volumes/"
quick_fix: "`docker system prune -a --volumes` removes stopped containers, unused networks, every image not used by a container, all build cache and unused anonymous volumes. Named volumes survive on Docker 23+; remove them with `docker volume prune -a`."
---

`docker system prune -a --volumes` is the biggest single cleanup command in the Docker CLI, and it is also the one most often run without knowing what it will take. This guide covers exactly what each flag removes, the Docker 23 change that made named volumes survive the command, how to preview the damage first, and how to filter and script pruning on build hosts and CI runners.

<!--more-->

## Quick Answer

`docker system prune -a --volumes` removes:

- **All stopped containers**
- **All networks not used by at least one container**
- **All images without at least one container associated to them** (`-a` widens this from dangling images to every unused image, tagged or not)
- **All build cache**, including BuildKit cache mounts from `RUN --mount=type=cache`
- **All anonymous volumes not used by at least one container** (`--volumes`)

> [!WARNING]
> Stopped containers are deleted first, so any image or anonymous volume that only a stopped container referenced is deleted in the same run. Volume data cannot be recovered. Back up anything you care about before running it.

On Docker Engine 23.0 and later (API 1.42+), **named volumes are not removed** by this command. To remove unused named volumes too, run `docker volume prune -a` separately.

This is the confirmation prompt Docker 29 prints, which is the most accurate summary of the command:

```console
$ docker system prune -a --volumes
WARNING! This will remove:
  - all stopped containers
  - all networks not used by at least one container
  - all anonymous volumes not used by at least one container
  - all images without at least one container associated to them
  - all build cache

Are you sure you want to continue? [y/N]
```

## What Each Flag Does

`docker system prune` has four options:

| Flag | Effect |
|------|--------|
| `-a`, `--all` | Remove all unused images, not just dangling ones |
| `--volumes` | Also prune anonymous volumes |
| `-f`, `--force` | Do not prompt for confirmation |
| `--filter` | Limit what is pruned, using `key=value` filters (API 1.28+) |

Without any flags, `docker system prune` removes stopped containers, unused networks, **dangling** images (untagged layers left behind by rebuilds) and build cache. Volumes are never touched unless you pass `--volumes`.

The difference between plain and `-a` is usually where most of the space lives. A dangling image is `<none>:<none>`. An unused image is anything no container references, including `postgres:16` you pulled last week and intend to use tomorrow. With `-a`, that image is gone and the next `docker run` pulls it again.

## Named Volumes and the Docker 23 Change

Before API 1.42, `docker volume prune` and `docker system prune --volumes` removed every unused volume, named or anonymous. Docker Engine 23.0 (API 1.42) changed the default: volume pruning now removes only **anonymous** volumes, and named volumes need an explicit opt in. The `-a`/`--all` flag for `docker volume prune` arrived in Engine 23.0.5.

The current behaviour, tested on Docker Engine 29.9.2 in a throwaway docker-in-docker daemon:

```console
$ docker volume create named-data
$ docker run --name stopped -v /anon alpine:3.20 true
$ docker volume ls
DRIVER    VOLUME NAME
local     d222b440951bb3af1ac945b532b3d5aeacfcbae89748051abdb59f8f4316be77
local     named-data

$ docker system prune -a --volumes -f
Deleted Containers:
c9f109c10527d10df8d3047e4eaf67250fca7f8d70247d80825fc5da7ae502c2

Deleted Volumes:
d222b440951bb3af1ac945b532b3d5aeacfcbae89748051abdb59f8f4316be77
...

$ docker volume ls
DRIVER    VOLUME NAME
local     named-data
```

The anonymous volume went, the named volume stayed. `docker system prune` has no flag that reaches named volumes, so a full wipe is two commands:

```bash
docker system prune -a --volumes -f
docker volume prune -a -f
```

`docker volume prune -a` prompts with a different, broader warning, which is your cue that named data is in scope:

```console
$ docker volume prune -a
WARNING! This will remove all local volumes not used by at least one container.
Are you sure you want to continue? [y/N]
```

> [!NOTE]
> If you have scripts written before 2023 that rely on `docker volume prune` to clear named volumes, they silently stopped doing that after the upgrade. Disk usage that creeps up on long-lived hosts after a Docker upgrade is often this.

## Preview Before You Prune

There is no dry run flag for any prune command. Use `docker system df` to see what is reclaimable:

```console
$ docker system df
TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE
Images          3         0         27.71MB   15.59MB (56%)
Containers      0         0         0B        0B
Local Volumes   2         0         0B        0B
Build Cache     5         0         20.85MB   16.38kB
```

`ACTIVE` counts objects in use by a container. `RECLAIMABLE` is an estimate for plain pruning; `-a` can free more than the Images row suggests because it also removes unused tagged images.

`docker system df -v` breaks every section down per object, including per volume `LINKS` (how many containers reference it) and per record build cache usage:

```console
$ docker system df -v
...
Build cache usage: 20.85MB

CACHE ID       CACHE TYPE        SIZE      CREATED         LAST USED                USAGE     SHARED
p64y6uczr7ye   regular           12.1MB    3 seconds ago   1 second ago             1         true
tek1iqg82y6i   exec.cachemount   4.1kB     3 seconds ago   Less than a second ago   2         false
...
```

To list the specific objects a run would remove, query each type with the matching filter:

```bash
# Stopped containers (removed by any system prune)
docker ps -a --filter status=exited --filter status=created

# Dangling images (removed by plain prune)
docker images --filter dangling=true

# Unused volumes; anonymous ones are what --volumes removes
docker volume ls --filter dangling=true

# Networks: compare this list against the networks your containers use
docker network ls
```

The `dangling=true` volume filter lists named and anonymous volumes alike. Anonymous volumes have 64 character hex names and carry the `com.docker.volume.anonymous` label on current engines, which makes them easy to tell apart.

## Filtering What Gets Pruned

`--filter` takes `key=value` pairs. Repeat the flag for multiple filters: different keys are combined with AND, the same key with OR.

`docker system prune` supports two filters:

- `until=<timestamp>`: only remove objects created before the given time. Accepts Unix timestamps, date strings, or Go durations such as `24h` or `1h30m`, relative to the daemon's clock.
- `label=<key>`, `label=<key>=<value>`, `label!=<key>`, `label!=<key>=<value>`: match objects with (or without) a label.

```bash
# Remove unused images, containers and networks older than a week
docker system prune -a -f --filter "until=168h"

# Remove only objects created by a CI job that labels its resources
docker system prune -a -f --filter "label=ci.job=build-1234"
```

The `until` filter cannot be combined with `--volumes`, and volumes do not support it at all:

```console
$ docker system prune -f --volumes --filter until=24h
ERROR: The "until" filter is not supported with "--volumes"

$ docker volume prune -f --filter until=24h
Error response from daemon: invalid filter 'until'
```

`docker volume prune` accepts only the `label` filter. To age out volumes, run the time based prune without `--volumes`, then prune volumes separately with a label filter.

## Protecting Images and Volumes

Pruning only removes objects nothing is using, so there are two ways to protect data: keep a container referencing it, or label it and exclude the label.

**Keep a container.** A running container protects its image, networks and volumes. A stopped container does not protect anything under `system prune`, because the container itself is deleted first.

**Label and exclude.** Labels survive on volumes and images and can be excluded with `label!=`:

```bash
# Label a named volume and an anonymous mount at creation time
docker volume create --label keep=true pgdata
docker run --mount type=volume,dst=/cache,volume-label=keep=true myapp:1

# Label images in the Dockerfile
#   LABEL keep=true

# Prune everything except labeled objects
docker system prune -a --volumes -f --filter "label!=keep=true"
docker volume prune -a -f --filter "label!=keep=true"
```

In testing, this kept the labeled image and both labeled volumes while everything else was removed.

> [!WARNING]
> Build cache records do not carry your labels, so `label!=keep=true` matches **all** of them and the whole build cache is deleted in the same run. If you want to keep build cache, prune images and volumes with their own commands (`docker image prune`, `docker volume prune`) instead of `docker system prune`.

## Reclaiming Build Cache Only

Build cache is often the largest consumer on CI hosts, and it is cheaper to rebuild than a pulled image set. Prune it on its own with `docker builder prune`. On current Docker releases with the buildx plugin installed, `docker builder prune` runs `docker buildx prune`, which supports size based retention:

```bash
# Remove unused build cache older than 24 hours
docker builder prune -f --filter "until=24h"

# Keep at most 20GB of cache, deleting least recently used records first
docker builder prune -f --max-used-space 20GB

# Keep 10GB reserved for cache regardless of other limits
docker builder prune -f --reserved-space 10GB

# Prune until the disk has at least 50GB free
docker builder prune -f --min-free-space 50GB

# Include internal/frontend images as well
docker builder prune -a -f
```

`--keep-storage` still works but is deprecated in buildx:

```console
$ docker builder prune --keep-storage 1GB -f
Flag --keep-storage has been deprecated, keep-storage flag has been changed to reserved-space
```

Use `--reserved-space` in new scripts.

## Running Prune From Scripts and Cron

The confirmation prompt blocks any non interactive run, so automation needs `-f`. Once `-f` is in a script, the filters are your only safety net. A reasonable nightly job for a build host:

```bash {filename="/usr/local/sbin/docker-cleanup.sh"}
#!/usr/bin/env bash
set -euo pipefail

# Keep the most recent week of images, containers and networks
docker system prune -a -f --filter "until=168h"

# Cap build cache instead of wiping it
docker builder prune -f --max-used-space 50GB

# Anonymous volumes only; named volumes are left alone
docker volume prune -f --filter "label!=keep=true"

docker system df
```

```bash {filename="/etc/cron.d/docker-cleanup"}
30 3 * * * root /usr/local/sbin/docker-cleanup.sh >> /var/log/docker-cleanup.log 2>&1
```

Operational notes:

- **Do not run `docker volume prune -a` on a schedule** on any host that keeps state in named volumes. A database container that is stopped for maintenance at 03:30 loses its data.
- **Pruning `-a` on CI runners trades disk for pull time.** If your runners pull the same base images every job, a size capped builder prune plus an `until` image prune usually beats a full wipe.
- **Pruning is I/O heavy.** Deleting a large build cache or many image layers on a busy host competes with running containers for disk. Schedule it off peak.
- **Log the output.** The `Deleted ...` lists and the `Total reclaimed space` line are the only record of what was removed.

## Troubleshooting

**Disk usage did not drop after a prune.** Check `docker system df` again. If `Local Volumes` is still large, the space is in named volumes, which `system prune --volumes` does not touch. If images are still large, a running or stopped container still references them (stopped ones are only removed by `system prune` or `docker container prune`).

**`docker volume prune -a` fails with an unknown flag error.** The CLI predates 23.0.5. Upgrade the client, or remove named volumes explicitly with `docker volume rm`.

**Space is not freed on disk even though Docker reports it reclaimed.** On thin provisioned or VM backed storage, the underlying disk may need a separate trim or compaction step before the host sees the space.

**An image you need keeps disappearing.** A scheduled `-a` prune is removing it between uses. Label the image and add `--filter "label!=keep=true"`, or drop `-a` so only dangling images are removed.

## Summary

- `docker system prune -a --volumes` removes stopped containers, unused networks, all unused images, all build cache and unused **anonymous** volumes.
- Since Docker 23 (API 1.42), named volumes survive it. Use `docker volume prune -a` to remove unused named volumes.
- Preview with `docker system df` and `docker system df -v`; there is no dry run.
- Use `--filter until=` for age based pruning (not with volumes) and `label!=` to protect objects, remembering build cache ignores labels.
- In scripts, pair `-f` with filters, and prefer size capped `docker builder prune` over wiping the cache.

For volume design that keeps data in places pruning will not reach by accident, see [Docker volumes for mutable files](/docker-volumes-mutable-files/).
