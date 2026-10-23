---
title: "Multi-Stage Docker Builds for Python and Node.js"
date: 2025-05-25T16:34:42-05:00
lastmod: 2026-10-23
draft: false
tags: ["Docker", "Dockerfile", "BuildKit", "Multi-Stage Builds", "Python", "Node.js", "Distroless", "dive"]
categories:
- Docker
- Containers
- "Build Systems"
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Measured multi-stage Dockerfiles for Python and Node.js: build in a fat stage, ship a slim or distroless one. 1.7 GB down to 223 MB, with cache mounts."
more_link: "yes"
quick_fix: |
  Build dependencies in a stage that has compilers, then copy only the result into a slim runtime stage: `COPY --from=build /opt/venv /opt/venv` for a Python virtualenv, or `COPY --from=deps /app/node_modules ./node_modules` after `npm ci --omit=dev` for Node.js.
  Measure before and after with `docker image ls` and `docker history`; deleting files in a later `RUN` never shrinks an image.
---

Multi-stage builds are easy to explain with Go, where the final stage holds one static binary. Python and Node.js are harder: the runtime needs an interpreter, a dependency tree, and sometimes native libraries, so you cannot just copy one file into `scratch`. This guide builds a real FastAPI service and a real Express service three ways, measures each image, and shows the stage layout that actually removes the weight.

<!--more-->

If you are building Go or another language that compiles to a static binary, [Multi-Stage Docker Builds: Reducing Image Sizes by 800MB](/multi-stage-docker-builds-reducing-image-sizes/) covers the `scratch` and distroless patterns for that case, and [How to Reduce Docker Image Size](/reduce-docker-image-size/) is the short checklist of general techniques. This post is about interpreted runtimes and about measuring.

All numbers below come from Docker Engine 29.8 with BuildKit on linux/amd64. Your exact sizes will differ with base image updates, but the ratios hold.

## Measure first: where the bytes actually are

Before changing a Dockerfile, find out what is in the image. Three commands answer most questions.

**`docker image ls`** gives two sizes on Docker Engine 29 with the containerd image store: `DISK USAGE` (unpacked on disk) and `CONTENT SIZE` (compressed, which is roughly what a node pulls). Older engines show a single `SIZE` column, which is the unpacked size.

```bash
docker image ls demo-py
# IMAGE           ID             DISK USAGE   CONTENT SIZE
# demo-py:multi   c8f480cd133d        223MB         53.8MB
# demo-py:naive   9449f45eb8c1        1.7GB          448MB
```

**`docker history`** shows the size each instruction added. This is where you see that a cleanup step does nothing:

```bash
docker history demo-py:naive --format '{{.Size}}\t{{.CreatedBy}}' | head -6
# 0B      CMD ["uvicorn" "app.main:app" "--host" "0.0.0.0" "--port" "8000"]
# 1.32MB  RUN /bin/sh -c apt-get purge -y build-essential && rm -rf /var/lib/apt/lists/*
# 37.5MB  RUN /bin/sh -c pip install -r requirements.txt
# 22.8MB  RUN /bin/sh -c apt-get update && apt-get install -y build-essential libpq-dev
# 20.5kB  COPY . . # buildkit
# 8.19kB  WORKDIR /app
```

The `purge` layer *adds* 1.32 MB. Layers are append only: removing a file in a later layer writes a whiteout entry, and the bytes stay in the earlier layer that every node still pulls.

**[dive](https://github.com/wagoodman/dive)** walks the layers and reports files that were written and later overwritten or deleted. Run it as a container so you do not have to install it, and set `CI=true` to get a report instead of the interactive UI:

```bash
docker run --rm -e CI=true \
  -v /var/run/docker.sock:/var/run/docker.sock \
  wagoodman/dive:v0.13.1 demo-py:naive
#   efficiency: 97.1952 %
#   wastedBytes: 34508349 bytes (34 MB)
# Inefficient Files:
#     2   21 MB  /var/lib/apt/lists/deb.debian.org_debian_dists_trixie_main_binary-amd64_Packages.lz4
```

Notice what dive does **not** flag: the naive image is 1.7 GB, and dive calls it 97% efficient. Its "wasted bytes" metric only counts files that were shadowed or deleted by a later layer. A compiler toolchain you installed and never removed is not "wasted" by that definition, it is just shipped. dive is good at catching cleanup done in the wrong layer; it will not tell you that your base image is the wrong one. `docker history` plus the base image size will.

In CI you can gate on dive's thresholds with `--ci` and `--lowestEfficiency`, `--highestWastedBytes` or `--highestUserWastedPercent`, but a plain size budget is usually the more useful check:

```bash
size=$(docker image inspect demo-py:multi --format '{{.Size}}')
[ "$size" -lt 300000000 ] || { echo "image is $size bytes, budget is 300 MB"; exit 1; }
```

## Python: build a virtualenv, copy the virtualenv

The demo is a FastAPI app that uses `psycopg2`. That package is a good test because installing it from source needs a C compiler and `libpq-dev`, while running it only needs the `libpq5` shared library.

```text {filename="requirements.txt"}
fastapi==0.115.12
uvicorn==0.34.2
psycopg2==2.9.10
```

### The naive version: 1.7 GB

```dockerfile {filename="Dockerfile.naive"}
FROM python:3.13
WORKDIR /app
COPY . .
RUN apt-get update && apt-get install -y build-essential libpq-dev
RUN pip install -r requirements.txt
RUN apt-get purge -y build-essential && rm -rf /var/lib/apt/lists/*
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

Two problems. The `python:3.13` base is the full Debian image with compilers and development headers already in it, which is most of the 1.7 GB. And the purge in its own `RUN` is useless, as `docker history` showed.

### The multi-stage version: 223 MB

The trick for Python is to install everything into a virtualenv at a fixed path in the build stage, then copy that one directory into a runtime stage built **from the same base image**. A virtualenv contains absolute paths to its interpreter, so the Python version and its location (`/usr/local/bin/python3` in the official images) must match between stages.

```dockerfile {filename="Dockerfile"}
# syntax=docker/dockerfile:1
FROM python:3.13-slim AS build
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev libpq-dev
RUN python -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH
COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt

FROM python:3.13-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends libpq5 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /opt/venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
WORKDIR /app
COPY app/ ./app/
USER 65532:65532
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

What each piece buys you:

- **`python:3.13-slim` in both stages.** The slim image has the interpreter and nothing else. The build stage adds `gcc`, `libc6-dev` and `libpq-dev`; none of them reach the runtime stage.
- **Cache mounts for apt and pip.** `--mount=type=cache` keeps the apt archives and the pip wheel cache between builds without writing them into a layer. Deleting `docker-clean` is required for the apt cache, because the Debian base images ship that file to throw downloaded packages away after every install. The pattern is from Docker's [build cache optimization guide](https://docs.docker.com/build/cache/optimize/).
- **Runtime libraries installed separately.** The runtime stage gets `libpq5` and cleans the apt lists **in the same `RUN`**, so the lists never land in a layer.
- **Code copied last.** `requirements.txt` is copied and installed before the application code, so editing `app/` does not invalidate the dependency layers.

Result, same app, same dependencies:

| Image | Disk usage | Content size (pulled) |
|---|---|---|
| `demo-py:naive` | 1.7 GB | 448 MB |
| `demo-py:multi` | 223 MB | 53.8 MB |

Check that the native extension still links against the runtime library:

```bash
docker run -d --rm --name demo-py -p 18000:8000 demo-py:multi
curl -s localhost:18000/healthz
# {"ok":true,"libpq":170011}
```

If the runtime stage is missing a shared library, this is where you find out: the import fails with `ImportError: libpq.so.5: cannot open shared object file`. Add the runtime package (not the `-dev` package) to the runtime stage.

## Node.js: separate production dependencies from the build

The Node.js demo is an Express 5 server written in TypeScript. The build needs TypeScript, type definitions, ESLint and Vitest; the runtime needs Express and the compiled JavaScript.

### The naive version: 1.8 GB

```dockerfile {filename="Dockerfile.naive"}
FROM node:22
WORKDIR /app
COPY . .
RUN npm install
RUN npm run build
CMD ["node", "dist/server.js"]
```

The full `node:22` image, every devDependency, the TypeScript sources, and whatever was in the build context (a local `node_modules` too, without a `.dockerignore`).

### The multi-stage version: 210 MB on distroless

Use three stages: one that installs **only** production dependencies, one that installs everything and compiles, and a runtime stage that takes the output of each.

```dockerfile {filename="Dockerfile"}
# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
EXPOSE 3000
CMD ["dist/server.js"]
```

Notes:

- **`npm ci --omit=dev` in its own stage.** Installing production dependencies separately is cleaner than running `npm prune` after a full install, and BuildKit builds the `deps` and `build` stages in parallel because neither depends on the other.
- **`/root/.npm` as a cache mount.** npm's download cache stays on the builder between runs and never enters a layer.
- **Distroless runtime.** `gcr.io/distroless/nodejs22-debian12` contains Node.js, glibc, CA certificates and little else: no shell, no package manager. Its entrypoint is already the `node` binary, so `CMD` is just the script path. The `:nonroot` tag runs as UID 65532.
- **No shell means no `docker exec -it ... sh`.** Debug with `kubectl debug` and an ephemeral container, or build a `:debug` variant of the image for local work. If your team relies on shelling into containers, use `node:22-bookworm-slim` as the runtime base instead. In this demo that costs 122 MB on disk (332 MB instead of 210 MB) and 27 MB more to pull.

| Image | Disk usage | Content size (pulled) |
|---|---|---|
| `demo-node:naive` | 1.8 GB | 449 MB |
| `demo-node:multi` | 210 MB | 53.3 MB |

```bash
docker run --rm --entrypoint sh demo-node:multi -c true
# exec: "sh": executable file not found in $PATH
```

That error is the point: there is nothing in the runtime image an attacker can use as a shell.

## Native modules in Node.js

Packages such as `bcrypt`, `sharp` or `better-sqlite3` ship prebuilt binaries for common platforms, but fall back to compiling with `node-gyp` when no prebuild matches. If that happens, install `python3`, `make` and `g++` in the `deps` stage only. The compiled `.node` files end up inside `node_modules`, so the runtime stage needs nothing extra unless the module links to a system library. Base both stages on the same Debian release (bookworm here, which is what `distroless/nodejs22-debian12` is built on) so the glibc version matches.

## Keep build secrets out of every layer

Private registries need a token at install time. Do not pass it with `ARG` or `COPY .npmrc`: build arguments show up in `docker history` of the stage that uses them, and a copied file lives in a layer even if you delete it later. Mount it as a build secret, which exists only for the duration of that one `RUN`:

```dockerfile
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc \
    --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev
```

```bash
docker build --secret id=npmrc,src=$HOME/.npmrc -t demo-node:multi .
```

The same pattern works for pip with `pip.conf` or a netrc file. After the build, `docker save demo-node:multi | strings | grep <token>` finds nothing.

## A `.dockerignore` that matters for interpreted languages

The build context is sent to BuildKit before anything runs. For Node.js the dangerous entry is a host `node_modules`, which can be hundreds of megabytes and contains binaries for the wrong OS; `COPY . .` would copy it straight over what `npm ci` installed.

```text {filename=".dockerignore"}
.git
node_modules/
dist/
coverage/
__pycache__/
*.pyc
.venv/
.pytest_cache/
*.log
.env*
Dockerfile*
.dockerignore
```

## Lint the Dockerfile in CI

Docker's build checks (Dockerfile 1.8 and Buildx 0.15 or later) run a set of rules without building anything:

```bash
docker build --check .
# Check complete, no warnings found.
```

Add `# check=error=true` under the `# syntax=` line to make warnings fail the build. See [Docker Build Checks and Dockerfile Best Practices](/post/docker-build-checks-dockerfile-best-practices-guide/) for the rule list.

## FAQ

### Why not use Alpine for Python?

Many Python wheels on PyPI are built for glibc (`manylinux`). On Alpine, which uses musl, pip often falls back to building from source, which needs the compilers you were trying to avoid and makes builds slower. `musllinux` wheels have closed some of that gap, but a slim Debian base is the predictable choice. For Node.js, Alpine works for pure JavaScript dependencies; native modules have the same musl caveat.

### Can I use distroless for Python too?

Google publishes `gcr.io/distroless/python3-debian12`, but its interpreter is whatever Debian 12 ships, not the Python from the official `python:3.13-slim` image, so a virtualenv built in one will not run in the other. If you want distroless Python, build the venv in a `debian:12` stage with Debian's own `python3` so the interpreter version and path match, and smoke test the result, because distroless has no shell to debug a broken venv with.

### My image is still big after all this. What next?

Run `docker history` on the runtime stage and look at the largest layer. It is almost always one of: the base image itself, a dependency that pulls in a large native library (machine learning packages are the usual suspects), or a `COPY` that brought in more than intended. [Docker Image Layer Caching: Optimization Strategies](/docker-image-layer-caching-optimization-strategies/) covers ordering instructions so the big layers are reused between builds.

### Do multi-stage builds make builds slower?

No, usually the opposite. Independent stages build in parallel, and with cache mounts the dependency install step reuses downloads even when the lock file changes.

## Related guides

- [Multi-Stage Docker Builds: Reducing Image Sizes by 800MB](/multi-stage-docker-builds-reducing-image-sizes/)
- [How to Reduce Docker Image Size](/reduce-docker-image-size/)
- [Docker Image Layer Caching: Optimization Strategies for Faster Builds](/docker-image-layer-caching-optimization-strategies/)
- [Docker Build Checks and Dockerfile Best Practices](/post/docker-build-checks-dockerfile-best-practices-guide/)
