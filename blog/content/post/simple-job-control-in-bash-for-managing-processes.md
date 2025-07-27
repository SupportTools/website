---
title: "Simple Job Control in Bash for Managing Processes"
date: 2024-05-19T11:11:00-05:00
draft: false
tags: ["Bash", "Job Control", "Scripting", "Automation"]
categories:
- DevOps
- Scripting
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to use simple job control in bash to manage multiple processes, restart them if they crash, and ensure they all stop together."
more_link: "yes"
---

Discover how to implement simple job control in bash to run multiple processes simultaneously, restart them if they crash, and ensure they all terminate together.

<!--more-->

# [Simple Job Control in Bash](#simple-job-control-in-bash)

In this guide, we'll explore how to use bash to manage multiple processes as part of a system test suite. We'll ensure they restart if they crash and stop together if the foreground process is terminated.

## [The Problem](#the-problem)

For our system test suite, we need to run several programs concurrently, ensuring they restart upon crashing and all terminate if the foreground process stops. Traditional tools like monit, upstart, or systemd are unsuitable as these are local, non-system processes typically run from a Makefile. Even the `forever` tool was inadequate for non-node processes. Thus, we turn to bash.

## [The Plan](#the-plan)

We will run a few `netcat` instances, each listening on a different port. These instances will act as stand-ins for our real processes. By avoiding the `-k` (keep listening) switch, we can quickly terminate them by sending data.

To send data, use the command:

```bash
echo "Hello World!" > /dev/tcp/localhost/9220
```

## [The Script](#the-script)

Here's the bash script to manage the processes:

```bash
#!/bin/bash

# When the script exits, kill the current process group.
trap "kill -- -$BASHPID" EXIT

# Run the command in the background.
# If it stops, restart it.
(while true; do
    nc -l 9220
done) &

(while true; do
    nc -l 9221
done) &

# Wait indefinitely (for Ctrl+C).
cat
```

## [Adding a Delay Before Restart](#adding-a-delay-before-restart)

To introduce a short delay before restarting the process, modify the script as follows:

```bash
(while true; do
    nc -l 9220
    sleep 1
done) &
```

## [Restart Only on Non-Zero Exit Status](#restart-only-on-non-zero-exit-status)

To restart the process only if it exits with a non-zero status, use:

```bash
(while nc -l 9220; do
    sleep 1
done) &
```

By following these steps, you can efficiently manage multiple processes in bash, ensuring they restart if they crash and all stop together when needed.
