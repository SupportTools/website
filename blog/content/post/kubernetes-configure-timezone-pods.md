---
title: "Kubernetes Timezone in Pods: TZ env, tzdata, /etc/localtime"
date: 2024-10-17T02:30:00-05:00
lastmod: 2026-10-23
draft: false
tags: ["Kubernetes", "Timezone", "Pods", "tzdata", "CronJob"]
categories:
- Kubernetes
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Kubernetes has no timezone setting, so pods run in UTC. Set env TZ=America/Chicago if the image has tzdata, or mount the zone file at /etc/localtime."
more_link: "yes"
url: "/kubernetes-configure-timezone-pods/"
quick_fix: |
  Kubernetes has no pod or cluster timezone field; containers use UTC unless the image says otherwise. Set the `TZ` environment variable on the container:
  `env: [{name: TZ, value: America/Chicago}]`, or `kubectl set env deployment/web TZ=America/Chicago`.
  This only works if the image contains `/usr/share/zoneinfo` (the `tzdata` package). Check with `kubectl exec deploy/web -- date`: it must show `CDT` or `CST`. If it shows `UTC` or `America`, install tzdata in the image or mount the zone file at `/etc/localtime` from a ConfigMap. For CronJob schedules, use `spec.timeZone` instead.
---

Kubernetes does not have a timezone setting for pods, namespaces or the cluster. A container gets whatever its image provides, which for almost every base image is UTC, and it does not inherit the node's timezone. To run a pod in a local timezone, set the `TZ` environment variable on the container, and make sure the image ships timezone data (`/usr/share/zoneinfo`). When the image has no timezone data, mount the zone file at `/etc/localtime` from a ConfigMap. Every method below was tested on Kubernetes 1.34 with the output shown.

<!--more-->

## The fix: set TZ on the container

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 1
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
      - name: app
        image: debian:trixie-slim
        command: ["sleep", "infinity"]
        env:
        - name: TZ
          value: America/Chicago
```

Or patch an existing workload, which triggers a normal rolling update:

```bash
kubectl set env deployment/web TZ=America/Chicago
kubectl rollout status deployment/web
kubectl exec deploy/web -- date
```

Expected output:

```text
Fri Oct 23 08:38:15 CDT 2026
```

The value is an IANA zone name such as `America/Chicago`, `Europe/Berlin` or `Asia/Tokyo`, not an abbreviation like `CST`. The C library, and most language runtimes, read `TZ` and load the matching file from `/usr/share/zoneinfo`.

## Why `date` shows "America" or still shows UTC

`TZ` is only a name. If the image has no `/usr/share/zoneinfo/America/Chicago`, nothing fails: the time silently stays in UTC.

```text
# busybox:1.37 or ubuntu:24.04 with TZ=America/Chicago and no tzdata
Fri Oct 23 13:38:47 America 2026

# alpine:3.22 or ubuntu:26.04 with TZ=America/Chicago and no tzdata
Fri Oct 23 13:38:22 UTC 2026
```

Both outputs are UTC time. The first form, where the zone abbreviation is the first part of the zone name, is the giveaway that the zone file was not found. Which images include tzdata:

| Image | tzdata included | `TZ` env alone works |
|---|---|---|
| `debian:bookworm-slim`, `debian:trixie-slim` | Yes | Yes |
| `ubuntu:24.04`, `ubuntu:26.04` | No | No, install `tzdata` |
| `alpine:3.22` | No | No, `apk add tzdata` |
| `busybox` | No | No, mount `/etc/localtime` or use a POSIX `TZ` string |
| `gcr.io/distroless/static`, `distroless/base` | Yes | Yes |
| `scratch` | No | Only if the binary embeds zone data |

## Option 2: add tzdata to the image

The cleanest fix when you build the image yourself:

```dockerfile
# Debian / Ubuntu
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tzdata \
 && rm -rf /var/lib/apt/lists/*

# Alpine
RUN apk add --no-cache tzdata
```

Keep the image itself in UTC and set `TZ` in the pod spec. That way the same image can run in any region, and you change the timezone with a manifest change instead of a rebuild.

## Option 3: mount the zone file from a ConfigMap

When you cannot change the image, ship the zone file as a ConfigMap and mount it over `/etc/localtime`. `kubectl` stores the binary file under `binaryData` automatically:

```bash
kubectl create configmap tz-chicago --from-file=localtime=/usr/share/zoneinfo/America/Chicago
```

```yaml
spec:
  containers:
  - name: app
    image: busybox:1.37
    command: ["sh", "-c", "date; sleep 3600"]
    volumeMounts:
    - name: tz
      mountPath: /etc/localtime
      subPath: localtime
      readOnly: true
  volumes:
  - name: tz
    configMap:
      name: tz-chicago
```

Result in a busybox container with no timezone data at all:

```text
Fri Oct 23 08:38:16 CDT 2026
```

`subPath` is required to mount a single file instead of replacing all of `/etc`. A subPath mount is not updated when the ConfigMap changes, which is fine here: zone files only change when governments change daylight saving rules, and then you recreate the ConfigMap and restart the pods.

## Option 4: hostPath from the node (works, but avoid it)

The original version of this guide mounted the node's zone file:

```yaml
    volumeMounts:
    - name: tz
      mountPath: /etc/localtime
      readOnly: true
  volumes:
  - name: tz
    hostPath:
      path: /usr/share/zoneinfo/America/Chicago
      type: File
```

It works, but it has three problems:

- **Pod Security.** The `baseline` and `restricted` Pod Security Standards forbid `hostPath` volumes. In a namespace labeled `pod-security.kubernetes.io/enforce=baseline`, the API server rejects the pod (`hostPath volumes`).
- **It depends on the node.** Minimal node OSes, Talos, Bottlerocket and some managed node images do not ship the same zone files, and `type: File` makes the pod fail to start if the path is missing.
- **It hides the timezone in node state** instead of the manifest.

Use the ConfigMap or the `TZ` variable instead.

## Option 5: a POSIX TZ string, no tzdata needed

The C library can parse a rule string directly, which works even in busybox and scratch-like images:

```yaml
        env:
        - name: TZ
          value: "CST6CDT,M3.2.0,M11.1.0"
```

```text
Fri Oct 23 08:38:20 CDT 2026
```

The string encodes the US Central rules (UTC minus 6, daylight time from the second Sunday of March to the first Sunday of November). It is correct today, but it will not follow future rule changes the way a zone file does, so prefer a zone name when you can.

## Edge case: mounting over a symlinked /etc/localtime

Debian images ship `/etc/localtime` as a symlink to `/usr/share/zoneinfo/Etc/UTC`. A file mount at `/etc/localtime` follows that symlink, so the zone file actually lands on top of `/usr/share/zoneinfo/Etc/UTC` inside the container. The result looks right, but now UTC is wrong too:

```text
$ date
Fri Oct 23 08:36:05 CDT 2026
$ TZ=Etc/UTC date
Fri Oct 23 08:36:05 CDT 2026
$ TZ=UTC date
Fri Oct 23 08:36:05 CDT 2026
$ date -u
Fri Oct 23 13:36:05 UTC 2026
```

Anything in that container that asks for UTC by name (log shippers, database clients, `TZ=UTC` in a script) silently gets Chicago time. On images that already include tzdata, use the `TZ` variable and do not mount `/etc/localtime`.

## Language runtimes

- **Go** reads `TZ` and loads `/usr/share/zoneinfo`. If the zone cannot be loaded, `time.Local` falls back to UTC without an error. For `scratch` or other images without tzdata, embed the database with `import _ "time/tzdata"` or build with `-tags timetzdata`.
- **Java** picks up `TZ` at JVM start; you can also pass `-Duser.timezone=America/Chicago` in `JAVA_TOOL_OPTIONS`.
- **Python** `zoneinfo` uses the system tzdata and falls back to the `tzdata` package from PyPI if it is installed.
- **Node.js** official builds include full ICU and honor `TZ`.
- **Databases** often have their own setting (PostgreSQL `timezone`, MySQL `time_zone`) that is independent of the container `TZ`.

## CronJobs: schedule timezone is a different setting

The pod's `TZ` does not change when a CronJob fires. The schedule is evaluated by kube-controller-manager, and it uses `spec.timeZone` (stable since Kubernetes 1.27, still the only option in 1.34 and 1.35):

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: nightly-report
spec:
  schedule: "0 2 * * *"
  timeZone: "America/Chicago"
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
          - name: report
            image: debian:trixie-slim
            command: ["date"]
            env:
            - name: TZ
              value: America/Chicago
```

Set both if the job should fire at 02:00 Chicago time and also log in Chicago time. Details are in [Kubernetes: Setting the Timezone for CronJobs](/kubernetes-cronjob-timezone/).

## Checklist

1. Pick an IANA zone name (`America/Chicago`), not an abbreviation.
2. Add `TZ` to the container `env` (pod template, Helm values or `kubectl set env`).
3. Run `kubectl exec <pod> -- date` and confirm the abbreviation is a real one (`CDT`, `CST`, `CET`).
4. If you see `UTC` or the first part of the zone name, the image lacks tzdata: install it, or mount a ConfigMap at `/etc/localtime` with `subPath`.
5. Do not mount `/etc/localtime` on images that already have tzdata (the symlink edge case above).
6. For CronJobs, also set `spec.timeZone`.

## FAQ

### Can I set one timezone for a whole namespace or cluster?

Not natively; there is no namespace or cluster timezone field in Kubernetes 1.34 or 1.35. The usual approaches are a mutating admission policy (Kyverno, Gatekeeper mutation, or a webhook such as k8tz) that injects `TZ` into every pod, or a shared Helm values file. Many teams instead keep every pod in UTC and convert times in the application or the dashboard.

### Does the node's timezone affect my pods?

No. Containers have their own filesystem, so the node's `/etc/localtime` is not visible unless you mount it. The node timezone matters for the CronJob default (`spec.timeZone` unset uses kube-controller-manager's zone) and for anything you read through `hostPath`.

### Do I need to restart pods after changing TZ?

Yes. Environment variables are read when the process starts. Changing the pod template with `kubectl set env` or `kubectl apply` rolls the Deployment automatically.

### Does TZ change the timestamps from `kubectl logs --timestamps`?

No. Those timestamps are added by the container runtime on the node when it writes the log file, not by your application. `TZ` only changes the times your application itself prints.

### Should production pods run in UTC?

Usually yes: UTC has no daylight saving jumps and makes logs from different regions line up. Set a local `TZ` only for software that must show or schedule in local time.

## Related guides

- [Kubernetes: Setting the Timezone for CronJobs](/kubernetes-cronjob-timezone/)
- [Securing Kubernetes Workloads with Pod Security Admission](/kubernetes-pod-security-admission/)
- [Kubernetes Static vs Dynamic ConfigMaps](/kubernetes-static-vs-dynamic-configmaps/)
