---
title: "Ollama Server Logs: Where to Find Them on Every OS"
date: 2025-04-17T00:00:00-05:00
lastmod: 2026-10-23
draft: false
tags: ["Ollama", "Logs", "Troubleshooting", "AI Models", "Server Management", "AI Tools"]
categories:
- Troubleshooting
author: "Matthew Mattox - mmattox@support.tools"
description: "Ollama logs: ~/.ollama/logs/server.log on macOS, journalctl -u ollama on Linux, %LOCALAPPDATA%\\Ollama on Windows, docker logs in containers."
more_link: "yes"
url: "/ollama-server-logs-guide/"
quick_fix: |
  macOS: `cat ~/.ollama/logs/server.log`. Linux (systemd install): `journalctl -u ollama --no-pager --follow`. Windows: `explorer %LOCALAPPDATA%\Ollama` and open `server.log`. Docker: `docker logs -f <container-name>`. For more detail, restart the server with `OLLAMA_DEBUG=1`.
---

When a model will not load, runs on the CPU instead of the GPU, or the API returns errors, the Ollama server log is the first place to look. This guide lists where the log lives on each platform, how to follow it live, and how to turn on debug logging.

<!--more-->

# Ollama Server Logs: A Platform-by-Platform Guide

## Finding Ollama Logs on macOS

The macOS app writes the server log to your home directory. Open a terminal and run:

```bash
cat ~/.ollama/logs/server.log
```

To watch new entries as they are written, use `tail -f`:

```bash
tail -f ~/.ollama/logs/server.log
```

## Accessing Ollama Logs on Linux Systems

The official Linux install script creates a systemd service named `ollama`, so the server logs go to the journal:

```bash
journalctl -u ollama --no-pager
```

To filter logs by time or follow new entries, use these options:

```bash
# View only recent logs
journalctl -u ollama --since "1 hour ago"

# Follow new log entries
journalctl -u ollama -f
```

If you start the server yourself with `ollama serve` instead of the service, the log is printed to that terminal (stderr). Redirect it if you want a file: `ollama serve 2> ollama.log`.

## Viewing Ollama Container Logs

In a container, Ollama logs to standard output and standard error. To access them:

1. First identify your container:

```bash
docker ps | grep ollama
```

2. Then view the logs with:

```bash
docker logs <container-name>
```

3. For continuous monitoring:

```bash
docker logs --follow <container-name>
```

The same commands work with Podman (`podman logs`). On Kubernetes, use `kubectl logs -f deploy/ollama -n <namespace>` (adjust the name to your deployment).

## Finding Ollama Logs on Windows

On Windows the logs live in your local application data folder:

- `%LOCALAPPDATA%\Ollama`: log files (`server.log` for the server, `app.log` for the tray app)
- `%HOMEPATH%\.ollama`: models and configuration

From Command Prompt:

```bat
explorer %LOCALAPPDATA%\Ollama
type %LOCALAPPDATA%\Ollama\server.log
```

From PowerShell, environment variables use a different syntax, and `Get-Content -Wait` works like `tail -f`:

```powershell
Get-Content "$env:LOCALAPPDATA\Ollama\server.log" -Tail 50 -Wait
```

The current log is `server.log`; older logs are rotated to `server-1.log`, `server-2.log` and so on.

## Enabling Detailed Debug Logging

For deeper troubleshooting, set `OLLAMA_DEBUG=1` before the server starts.

### On macOS

Quit the Ollama app from the menu bar first, then run the server in a terminal:

```bash
OLLAMA_DEBUG=1 ollama serve
```

### On Linux (systemd service)

Add the variable to the service with an override, then restart it:

```bash
sudo systemctl edit ollama
# In the editor, add:
# [Service]
# Environment="OLLAMA_DEBUG=1"
sudo systemctl daemon-reload
sudo systemctl restart ollama
journalctl -u ollama -f
```

### On Windows

Quit Ollama from the system tray first, then in PowerShell:

```powershell
$env:OLLAMA_DEBUG="1"
ollama serve
```

### In Containers

```bash
docker run -d -e OLLAMA_DEBUG=1 -p 11434:11434 --name ollama ollama/ollama
```

## Interpreting Common Log Messages

Ollama writes structured lines in the form `time=... level=INFO source=... msg="..."`. Useful things to search for:

- `level=WARN` and `level=ERROR`: problems worth reading first
- Lines mentioning `inference compute` or `library=cuda` / `library=rocm`: which GPU, if any, Ollama detected at startup
- `offload` and `layers`: how many model layers were placed on the GPU; few or zero layers on the GPU explains slow responses
- `out of memory`: the model, or its context size, does not fit in the available RAM or VRAM

To filter quickly on Linux:

```bash
journalctl -u ollama --since today | grep -E "level=(WARN|ERROR)"
```

## FAQ

### Why is there no server.log on Linux?

Because the systemd service sends output to the journal instead of a file. Use `journalctl -u ollama`. The `~/.ollama/logs` directory is used by the macOS app.

### How do I see why Ollama is using the CPU instead of the GPU?

Restart the server with `OLLAMA_DEBUG=1` and read the startup lines about GPU discovery. Missing drivers, an unsupported GPU, or a container started without GPU access (for Docker, `--gpus=all`) are the usual causes.

### How do I keep the log from growing forever?

On Linux the journal is size limited by `journald` settings (`SystemMaxUse` in `/etc/systemd/journald.conf`). In Docker, set a log driver limit such as `--log-opt max-size=10m --log-opt max-file=3`.

### Where are Ollama models stored, if not next to the logs?

In `~/.ollama/models` on macOS and Windows (`%HOMEPATH%\.ollama\models`), and in `/usr/share/ollama/.ollama/models` for the Linux systemd service. Set `OLLAMA_MODELS` to move them.

## Related Guides

- [Qwen 2.5 Coder Models: Open-Weight LLMs for Self-Hosting](/qwen-coder-models-guide/)
- [Self-Hosted Coding Agents on Kubernetes](/self-hosted-coding-agents-kubernetes-vllm-litellm-enterprise-guide/)
- [GPU Cluster Management for AI Workloads with NVIDIA Operator](/gpu-cluster-management-ai-workloads-nvidia-operator/)
- [Setting up Nvidia drivers for k3s](/post/nvidia-gpus-on-k3s/)
