---
title: "The Practical Cron Guide: Scheduling Jobs on Linux the Right Way"
date: 2032-05-09T09:00:00-05:00
draft: false
tags: ["Linux", "cron", "crontab", "Scheduling", "systemd", "Kubernetes", "CronJob", "Automation", "SRE", "DevOps", "Bash", "flock"]
categories:
- Linux
- Automation
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "The definitive practical guide to cron on Linux: crontab syntax, system vs user crontabs, PATH and environment gotchas, capturing output, preventing overlap with flock, timezones, debugging, and modern alternatives."
more_link: "yes"
url: "/practical-cron-guide-scheduling-jobs-linux/"
---

Cron is the oldest piece of automation still running in nearly every production Linux environment, and it is also the one almost everyone configures slightly wrong. A job that runs perfectly from an interactive shell silently does nothing at 3 a.m. A backup script overlaps with the previous run and corrupts a snapshot. A cron job fails for three weeks before anyone notices, because its output went nowhere. None of these are cron bugs. They are predictable consequences of how cron actually works, and every one of them is avoidable once the model is clear.

This is the canonical practical reference for cron on Linux. It covers the five-field syntax in full, the difference between user crontabs and the system crontab, the environment and `PATH` traps that cause the classic "works on the command line but not in cron" failure, how to capture output so jobs never fail silently, how to prevent overlapping runs with `flock`, timezones, a concrete debugging checklist for when a job did not run, and how cron relates to the two modern schedulers that have grown up around it: **systemd timers** and **Kubernetes CronJobs**.

<!--more-->

## What Cron Is and Which Daemon You Actually Have

**Cron** is a daemon that wakes up once a minute, reads a set of schedule tables called **crontabs**, and runs any command whose schedule matches the current time. It has no concept of dependencies, retries, or success: it runs commands and, by default, mails their output to the owning user. Everything beyond that is something you build on top.

On a typical Linux host the running daemon is one of a few implementations, and the differences matter:

- **Vixie cron / cronie** is the classic implementation, standard on RHEL, Rocky, Alma, and Fedora as the `cronie` package. It supports per-user crontabs, the system crontab, `/etc/cron.d`, and environment variable assignments inside crontab files.
- **ISC cron** on Debian and Ubuntu (the `cron` package) is a close descendant of Vixie cron with the same feature set.
- **anacron** is a companion, not a replacement. It exists to run jobs that should happen *periodically* even on machines that are not powered on continuously (laptops, workstations). It does not run on a precise schedule; it tracks the last time each job ran and catches up after boot. On servers that stay up, the `cron.daily` / `cron.weekly` directories are usually driven by anacron, which is why those jobs run at a fuzzy time rather than exactly when listed.

Confirm what is installed and running before you debug anything:

```bash
# Identify the cron package and confirm the daemon is active
systemctl status cron 2>/dev/null || systemctl status crond 2>/dev/null

# Debian/Ubuntu use the service name "cron"; RHEL-family use "crond"
systemctl is-enabled crond 2>/dev/null || systemctl is-enabled cron

# Check whether anacron is present and handling the periodic directories
which anacron && cat /etc/anacrontab
```

If `systemctl status` shows the daemon is dead, no schedule on the box will ever fire. That single check resolves a surprising share of "my cron job isn't running" tickets.

## Crontab Syntax: The Five Fields

Every standard crontab entry is five time fields followed by the command to run. The fields, in order, are minute, hour, day-of-month, month, and day-of-week.

```crontab
# ┌───────────── minute        (0 - 59)
# │ ┌───────────── hour          (0 - 23)
# │ │ ┌───────────── day of month (1 - 31)
# │ │ │ ┌───────────── month        (1 - 12)
# │ │ │ │ ┌───────────── day of week  (0 - 7, where 0 and 7 are Sunday)
# │ │ │ │ │
# * * * * * command-to-run
```

A field can hold a single value, a list, a range, a step, or the wildcard `*` meaning "every value". Combining these covers almost every schedule you will ever need.

```crontab
# Every minute (the wildcard in all five fields)
* * * * * /usr/local/bin/heartbeat.sh

# 02:30 every day (a specific minute and hour, wildcards for the rest)
30 2 * * * /usr/local/bin/nightly-backup.sh

# Top of every hour
0 * * * * /usr/local/bin/rotate-cache.sh

# A LIST: 09:00, 12:00, and 17:00 on weekdays
0 9,12,17 * * 1-5 /usr/local/bin/business-hours-sync.sh

# A RANGE: every hour from 08:00 through 18:00
0 8-18 * * * /usr/local/bin/poll-queue.sh

# A STEP: every 15 minutes (0, 15, 30, 45)
*/15 * * * * /usr/local/bin/collect-metrics.sh

# A STEP over a RANGE: every 2 hours between 00:00 and 22:00
0 0-22/2 * * * /usr/local/bin/replicate.sh

# First day of every month at 04:00
0 4 1 * * /usr/local/bin/monthly-report.sh
```

A few rules that trip people up:

- **`*/N` is a step, not "every N from now."** `*/15` in the minute field means minutes that are evenly divisible by 15 within the field's range, so 0, 15, 30, 45 — anchored to the top of the hour, not to when you saved the crontab.
- **Day-of-month and day-of-week are OR, not AND.** This is the single most misunderstood rule in cron. When both the day-of-month field and the day-of-week field are restricted (neither is `*`), cron runs the job when *either* matches. `0 0 13 * 5` does not mean "midnight on Friday the 13th"; it means "midnight on the 13th of every month, AND every Friday." To get a true Friday-the-13th job you must test the date inside the command.
- **Names are allowed for months and weekdays.** `jan`–`dec` and `sun`–`sat` work, case-insensitively, in place of numbers. `0 6 * * mon-fri` is clearer than `0 6 * * 1-5`.
- **Both 0 and 7 are Sunday.** The day-of-week field accepts 0–7 with both ends meaning Sunday.

When you are unsure what an expression means, do not guess — describe it in a comment and verify against a reference such as the explanations at [crontab.guru](https://crontab.guru). A one-line comment above every entry is cheap insurance.

## Managing Crontabs: edit, list, remove

User crontabs are not meant to be edited as files directly. They live in a spool directory (`/var/spool/cron/crontabs/` on Debian/Ubuntu, `/var/spool/cron/` on RHEL-family) that the daemon owns, and you interact with them through the `crontab` command.

```bash
# Edit the current user's crontab in $EDITOR (this is the safe, validated path)
crontab -e

# List the current user's crontab to stdout
crontab -l

# Remove the current user's crontab entirely (no confirmation prompt!)
crontab -r

# Operate on another user's crontab (requires root)
sudo crontab -l -u deploy
sudo crontab -e -u deploy
```

Two operational warnings:

- **`crontab -r` deletes immediately with no prompt.** The flags `-r` and `-e` are adjacent on the keyboard and the mistake is common. Back up before touching anything: `crontab -l > ~/crontab.$(date +%F).bak`. On many systems `crontab -i` adds an interactive confirmation to removal; prefer it if available.
- **Editing the spool file by hand can be ignored or rejected.** `crontab -e` writes to a temp file, validates the syntax on save, and only then installs it. Hand-editing the spool file skips that validation and may not be picked up cleanly. Always go through `crontab -e`.

For deployment automation where an interactive editor is not available, install a crontab from a file in source control:

```bash
# Install a crontab from a version-controlled file (idempotent, deploy-friendly)
crontab /opt/app/deploy/app.crontab

# Or pipe it in, useful in CI pipelines and container entrypoints
cat /opt/app/deploy/app.crontab | crontab -
```

## System Crontab vs User Crontabs vs /etc/cron.d

There are three distinct places cron reads schedules from, and they differ in one critical way: whether the line includes a username field.

### User crontabs (`crontab -e`)

Five time fields, then the command. The job runs as the user who owns the crontab. No username field.

```crontab
# A user crontab line: five fields, then the command (runs as the owning user)
30 2 * * * /usr/local/bin/nightly-backup.sh
```

### The system crontab (`/etc/crontab`)

The system-wide crontab and the drop-in files in `/etc/cron.d/` use **six** fields: the five time fields, then a **username**, then the command. This lets the system run jobs as any user. Forgetting the username field here is one of the most common silent-failure causes, because cron treats the username as the start of the command.

```crontab
# /etc/crontab and /etc/cron.d/* require a USER field after the time fields
# m  h  dom mon dow  user      command
  17 *  *   *   *    root      cd / && run-parts --report /etc/cron.hourly
  30 3  *   *   *    deploy    /opt/app/bin/cleanup-sessions.sh
```

### Drop-in directory (`/etc/cron.d/`)

`/etc/cron.d/` is the right place for jobs delivered by packages, configuration management, or your own deployments. Each application gets its own file, which is far cleaner than appending to a shared `/etc/crontab` and is trivial to manage with Ansible, Puppet, or a Debian/RPM package.

```crontab
# /etc/cron.d/myapp-maintenance
# Use the six-field form; set environment explicitly at the top of the file.
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
MAILTO=ops-alerts@support.tools

# m  h  dom mon dow  user    command
  */5 * *  *   *     deploy  /opt/app/bin/flush-queue.sh
  0  4  *  *   0     deploy  /opt/app/bin/weekly-vacuum.sh
```

A subtlety with `/etc/cron.d`: filenames must consist only of letters, digits, underscores, and hyphens. A file named `myapp.cron` or `myapp.conf` is **silently ignored** because the dot disqualifies it (this mirrors `run-parts` naming rules). Name the file `myapp-maintenance`, not `myapp.cron`.

### The convenience directories

`/etc/cron.hourly/`, `/etc/cron.daily/`, `/etc/cron.weekly/`, and `/etc/cron.monthly/` hold **executable scripts**, not crontab lines. A line in `/etc/crontab` (or anacron) runs everything in each directory at the appropriate interval using `run-parts`. To add a daily job this way, drop an executable script with no file extension into `/etc/cron.daily/` and make sure it is `chmod +x`. The exact time these fire depends on `/etc/crontab` and whether anacron is in play, so they are appropriate for "once a day, time not critical," not "exactly at 02:00."

```bash
# Install a daily maintenance script the run-parts way
sudo install -m 0755 cleanup-temp.sh /etc/cron.daily/cleanup-temp

# Verify run-parts will accept it (no extension, executable, valid name)
run-parts --test /etc/cron.daily
```

## The PATH and Environment Trap

This is the cause of nearly every "it works when I run it manually but cron never does anything" report. Cron does **not** run your job in your interactive shell. It does not source `~/.bashrc`, `~/.bash_profile`, or `/etc/profile`. It runs the command with a minimal environment and a very short `PATH`, typically just `/usr/bin:/bin`.

Prove it to yourself by capturing cron's real environment:

```crontab
# Temporary diagnostic: dump cron's environment to a file once a minute
* * * * * env > /tmp/cron-env.txt 2>&1
```

```bash
# After a minute, inspect what cron actually provided
cat /tmp/cron-env.txt
# Typical output — note the bare PATH and missing HOME customizations:
# HOME=/home/deploy
# LOGNAME=deploy
# PATH=/usr/bin:/bin
# SHELL=/bin/sh
# PWD=/home/deploy
```

The consequences are immediate. A script that calls `docker`, `kubectl`, `aws`, `psql`, `node`, or anything in `/usr/local/bin` will fail with "command not found" because that directory is not on cron's `PATH`. A Python script relying on a virtualenv activated in your shell will use the system interpreter instead.

There are three reliable fixes, in order of preference:

```crontab
# Fix 1 (best): set PATH and SHELL at the top of the crontab itself.
# These assignments apply to every job below them in the same crontab.
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

0 2 * * * /opt/app/bin/backup.sh
```

```bash
# Fix 2: use absolute paths for every binary inside the script.
#!/usr/bin/env bash
set -euo pipefail
/usr/local/bin/kubectl get nodes
/usr/bin/psql -c 'VACUUM ANALYZE;'
```

```bash
# Fix 3: have the script source its own environment, never relying on cron's.
#!/usr/bin/env bash
set -euo pipefail
# Load the deployment's environment explicitly
source /opt/app/env/production.env
export PATH="/opt/app/venv/bin:$PATH"
python -m app.tasks.nightly_rollup
```

A related gotcha: the **percent sign `%` is special in crontab commands**. An unescaped `%` is converted to a newline, and everything after the first `%` becomes standard input to the command. This breaks any command using `date +%Y-%m-%d` directly in a crontab line. Escape each one as `\%`:

```crontab
# WRONG: the %Y, %m, %d are turned into newlines and stdin
0 1 * * * tar czf /backup/db-`date +%Y%m%d`.tgz /var/lib/db

# RIGHT: escape the percent signs
0 1 * * * tar czf /backup/db-`date +\%Y\%m\%d`.tgz /var/lib/db

# BEST: move the logic into a script and keep the crontab line trivial
0 1 * * * /opt/app/bin/db-backup.sh
```

The lesson that prevents most of these problems: **keep crontab lines trivial and put real logic in a script.** A script has a shebang, can `set -euo pipefail`, can source its environment, and can be tested directly. A crontab line cannot.

## Capturing Output: Never Let a Job Fail Silently

By default, cron captures everything a job writes to stdout and stderr and **mails it to the job's owner** using the local mail transfer agent. On a modern server with no MTA configured, that mail goes nowhere, which means a failing job produces no visible signal at all. This is how jobs fail for weeks unnoticed.

You have two jobs here: route output somewhere durable, and make sure failures actually get seen.

### MAILTO

The `MAILTO` variable controls where cron sends job output. Set it explicitly at the top of the crontab. If a working MTA or SMTP relay exists, this is the simplest alerting path — you get mailed only when a job produces output, and a well-behaved successful job produces none.

```crontab
# Mail any output (which usually means errors) to the ops team
MAILTO=ops-alerts@support.tools

0 2 * * * /opt/app/bin/backup.sh

# Set MAILTO="" to discard output for a single noisy job that you log elsewhere
MAILTO=""
*/5 * * * * /opt/app/bin/metrics-push.sh >> /var/log/metrics-push.log 2>&1
```

### Redirecting to logs

The more robust pattern on servers without mail is to redirect output to a log file. The critical detail is `2>&1`, which redirects stderr to the same place as stdout. Without it, error messages — the output you most want — escape your log and fall back to (nonexistent) mail.

```crontab
# Append both stdout AND stderr to a log file. The 2>&1 MUST come after the >>
0 2 * * * /opt/app/bin/backup.sh >> /var/log/app/backup.log 2>&1

# A common mistake: this captures stdout but lets stderr go to cron mail
0 2 * * * /opt/app/bin/backup.sh >> /var/log/app/backup.log
```

Ordering matters: `>> file 2>&1` sends stdout to the file and then points stderr at the same destination. Writing `2>&1 >> file` does the opposite of what you expect, because `2>&1` is evaluated first and duplicates stderr onto wherever stdout currently points (the terminal/mail), before stdout is redirected to the file.

### Making failures loud

Logging is necessary but passive; nobody reads logs until something is already on fire. For anything important, exit non-zero on failure and alert on that. Two robust patterns:

```bash
#!/usr/bin/env bash
# A wrapper that runs the real job and pings a dead-man's-switch on success.
# If the job fails (non-zero exit) the ping is skipped, and the monitoring
# service alerts because the expected check-in never arrived.
set -euo pipefail

PING_URL="https://hc-ping.com/your-unique-uuid"

if /opt/app/bin/nightly-rollup.sh; then
    curl -fsS --max-time 10 --retry 3 "${PING_URL}" >/dev/null
else
    # Optionally signal the failure endpoint explicitly
    curl -fsS --max-time 10 "${PING_URL}/fail" >/dev/null
    exit 1
fi
```

```bash
#!/usr/bin/env bash
# Trap any error and post a structured alert to a webhook before exiting.
set -euo pipefail

WEBHOOK="https://chat.support.tools/hooks/cron-alerts"
JOB_NAME="nightly-rollup"

notify_failure() {
    local exit_code=$?
    local line=$1
    curl -fsS --max-time 10 -H 'Content-Type: application/json' \
        -d "{\"text\":\"cron job ${JOB_NAME} failed (exit ${exit_code}) at line ${line} on $(hostname)\"}" \
        "${WEBHOOK}" >/dev/null || true
    exit "${exit_code}"
}
trap 'notify_failure ${LINENO}' ERR

# Real work below; any non-zero exit triggers the trap
/opt/app/bin/do-the-rollup
```

The dead-man's-switch pattern (a periodic check-in that alerts on *absence*) is the strongest design, because it also catches the case where cron itself stopped running or the host was down. A redirect-to-log job that never runs produces no log and no alert; a check-in job that never checks in does.

## Preventing Overlapping Runs with flock

Cron has no idea whether a previous run of a job is still going. If a job scheduled every five minutes occasionally takes seven minutes, cron will start a second copy on top of the first. For backups, database maintenance, or anything touching shared state, overlapping runs range from wasteful to catastrophic.

The clean, standard solution is `flock` (from `util-linux`), which acquires an advisory lock on a file and runs the command only if the lock is free.

```crontab
# -n means non-blocking: if the lock is held, exit immediately rather than queue.
# This is what you want for periodic jobs — skip this run, try again next interval.
*/5 * * * * /usr/bin/flock -n /var/lock/queue-flush.lock /opt/app/bin/flush-queue.sh
```

```bash
#!/usr/bin/env bash
# flock inside a script via a self-locking idiom. The script re-executes itself
# under flock on its own file descriptor, so callers don't need to remember the
# wrapper. "200" is an arbitrary high FD number.
set -euo pipefail

LOCKFILE="/var/lock/$(basename "$0").lock"
exec 200>"${LOCKFILE}"

# Non-blocking: bail out cleanly if another instance holds the lock
if ! flock -n 200; then
    echo "$(date -Is) another instance is already running; exiting" >&2
    exit 0
fi

# Real work runs here, guaranteed single-instance
/opt/app/bin/long-running-maintenance
```

Two flags decide the behavior when the lock is busy:

- **`-n` (non-blocking):** exit immediately if the lock is held. Correct for periodic jobs where a skipped run is fine and will be retried at the next interval.
- **`-w <seconds>` (wait with timeout):** block up to N seconds for the lock, then give up. Useful when you genuinely want the job to run but not pile up indefinitely.

Avoid the temptation to roll your own lock with a PID file and a check — it has a race condition between checking and writing, and it leaks the lock if the script is killed (`kill -9`) before cleanup. `flock` ties the lock to an open file descriptor, so the kernel releases it automatically the instant the process dies, no matter how it dies.

## Special Strings: @reboot, @daily, and Friends

Most cron implementations accept a set of shorthand strings in place of the five time fields. They read more clearly than numeric equivalents for common schedules.

```crontab
# Run once after the system boots (cron starts the job, not at exact boot time)
@reboot     /opt/app/bin/warm-cache.sh

# Equivalent to: 0 0 * * *  (midnight every day)
@daily      /opt/app/bin/nightly-backup.sh

# @midnight is a synonym for @daily
@midnight   /opt/app/bin/rotate-logs.sh

# Equivalent to: 0 * * * *  (top of every hour)
@hourly     /opt/app/bin/poll-feeds.sh

# Equivalent to: 0 0 * * 0  (midnight on Sunday)
@weekly     /opt/app/bin/weekly-report.sh

# Equivalent to: 0 0 1 * *  (midnight on the 1st)
@monthly    /opt/app/bin/monthly-rollup.sh

# Equivalent to: 0 0 1 1 *  (midnight on January 1st)
@yearly     /opt/app/bin/annual-archive.sh
```

`@reboot` deserves a caution. It runs when cron starts, which is during boot — but not necessarily after the network, mounted volumes, or dependent services are up. For anything with real startup ordering requirements, a systemd unit with proper `After=` / `Requires=` dependencies is far more reliable than `@reboot`. Treat `@reboot` as "best-effort warmup," not "guaranteed init."

## Timezones: The Quiet Source of Off-by-Hours Bugs

By default, cron evaluates schedules in the **system's local timezone**, whatever `/etc/localtime` points to. This produces two recurring problems.

First, **daylight saving time transitions create gaps and duplicates.** When clocks spring forward, a job scheduled for 02:30 in a timezone that skips from 02:00 to 03:00 simply does not run that day. When clocks fall back and the 02:00 hour repeats, behavior varies by implementation. The robust answer for anything sensitive is to run the host in **UTC** and schedule in UTC, eliminating DST entirely.

```bash
# Check the host's current timezone
timedatectl

# Set the host to UTC so cron schedules are DST-free and unambiguous
sudo timedatectl set-timezone UTC
```

Second, when you cannot change the host timezone, some cron implementations honor a `CRON_TZ` variable at the top of a crontab to set the timezone for the entries that follow. Support varies, so confirm it works on your platform before relying on it.

```crontab
# Run this job at 09:00 New York time regardless of the system timezone
# (cronie/Vixie supports CRON_TZ; verify on your distro before depending on it)
CRON_TZ=America/New_York
0 9 * * 1-5 /opt/app/bin/market-open-sync.sh
```

The pragmatic enterprise default: **set every server to UTC, schedule everything in UTC, and convert to local time only at the presentation layer.** It removes an entire class of twice-a-year incidents.

## Debugging: Why Didn't My Cron Job Run?

When a job did not run, work through this checklist in order. The cause is almost always early in the list.

```bash
# 1. Is the cron daemon even running?
systemctl status cron 2>/dev/null || systemctl status crond

# 2. Did cron see and attempt the job? Check the system/cron log.
#    Debian/Ubuntu:
sudo journalctl -u cron --since "today" --no-pager
sudo grep CRON /var/log/syslog
#    RHEL-family:
sudo journalctl -u crond --since "today" --no-pager
sudo cat /var/log/cron
```

A line like `(deploy) CMD (/opt/app/bin/backup.sh)` in the log proves cron *started* the command. If you see that line but the job did nothing useful, the problem is inside the job (PATH, permissions, a bug) — not cron's scheduling. If you do not see that line at all, cron never matched the schedule, which points at the crontab itself.

```bash
# 3. Confirm the crontab actually contains the entry you think it does
crontab -l
sudo crontab -l -u deploy        # check the right user's crontab
sudo cat /etc/crontab            # and the system crontab
ls -la /etc/cron.d/              # and the drop-in directory

# 4. Validate the file naming and permissions for /etc/cron.d entries
#    (a dot in the filename or a bad username field = silently ignored)
sudo cat /etc/cron.d/myapp-maintenance
```

```bash
# 5. Reproduce cron's restricted environment to find PATH/env failures.
#    env -i clears the environment; this mimics cron far better than your shell.
env -i /bin/sh -c '/opt/app/bin/backup.sh'

# 6. Confirm the script is executable and has a valid shebang
ls -l /opt/app/bin/backup.sh
head -1 /opt/app/bin/backup.sh
```

The most common findings, in rough order of frequency:

- The daemon was stopped or disabled (step 1).
- The job ran fine but its output went to nonexistent mail, hiding an error (capture output as above).
- A `PATH` or environment difference made a command "not found" under cron (step 5).
- An `/etc/cron.d` file was ignored because of a dot in its name or a missing username field.
- A `%` in the command line was interpreted as a newline (escape it as `\%`).
- The day-of-month / day-of-week OR rule made the job run more or less often than intended.
- The crontab is missing its final newline. Some cron versions ignore the last line if the file does not end in a newline — always leave a trailing blank line.

## Modern Alternatives: systemd Timers

On any systemd-based distribution, **systemd timers** are a more capable replacement for cron, and increasingly the default for system-level scheduling. A timer is two units: a `.service` that defines what to run and a `.timer` that defines when. The advantages over cron are substantial: jobs run as fully tracked units with cgroup resource limits, output goes to the journal automatically (no MTA or redirect gymnastics), failed jobs can trigger `OnFailure=` handlers, `Persistent=true` catches up missed runs after downtime like anacron, and `RandomizedDelaySec=` spreads load across a fleet.

```ini
# /etc/systemd/system/nightly-backup.service
[Unit]
Description=Nightly application backup
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=deploy
# Environment is explicit and predictable, unlike cron
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/opt/app/bin/backup.sh
```

```ini
# /etc/systemd/system/nightly-backup.timer
[Unit]
Description=Run the nightly backup at 02:30

[Timer]
# Calendar expression; "OnCalendar" replaces the five cron fields
OnCalendar=*-*-* 02:30:00
# Catch up if the machine was off when the timer should have fired
Persistent=true
# Jitter to avoid a thundering herd across many hosts
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
```

```bash
# Enable and start the timer, then verify the next scheduled run
sudo systemctl daemon-reload
sudo systemctl enable --now nightly-backup.timer

# See all timers and their next/last run times
systemctl list-timers --all

# Read the job's output from the journal (no log redirect needed)
journalctl -u nightly-backup.service --since "today"

# Run the job on demand for testing, exactly as the timer would
sudo systemctl start nightly-backup.service
```

Use cron when you want a single, portable, dependency-free line that works on anything from a BusyBox container to a forty-year-old Unix box. Reach for systemd timers when you need resource limits, reliable logging, missed-run catch-up, failure handling, or dependency ordering — that is, for most serious system jobs on a modern distro.

## The Kubernetes Bridge: CronJobs

In a Kubernetes environment, scheduled work moves off individual hosts and into the cluster as a **CronJob** object. It uses the exact same five-field schedule syntax as classic cron, but the execution model is entirely different: each fire creates a `Job`, which creates one or more `Pods`, and the cluster handles placement, retries, and cleanup.

```yaml
# A production-grade CronJob with the controls cron never had
apiVersion: batch/v1
kind: CronJob
metadata:
  name: nightly-rollup
  namespace: data-platform
spec:
  # Same five-field syntax as crontab: 02:30 every day
  schedule: "30 2 * * *"
  # Pin the schedule to a timezone (Kubernetes 1.27+ stable field)
  timeZone: "Etc/UTC"
  # Skip a run if the previous one is still active — the flock equivalent
  concurrencyPolicy: Forbid
  # If the controller was down, only start a run if it's within this many seconds
  startingDeadlineSeconds: 300
  # Keep history bounded so old Jobs don't accumulate
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      # Bounded retries instead of cron's silent never-retry
      backoffLimit: 2
      # Hard wall-clock limit so a hung job can't run forever
      activeDeadlineSeconds: 3600
      # Clean up finished Jobs automatically 24h after completion
      ttlSecondsAfterFinished: 86400
      template:
        spec:
          restartPolicy: Never
          containers:
            - name: rollup
              image: registry.support.tools/data/rollup:1.8.2
              command: ["/opt/app/bin/nightly-rollup.sh"]
              resources:
                requests:
                  cpu: "250m"
                  memory: "256Mi"
                limits:
                  cpu: "1"
                  memory: "512Mi"
```

Map each CronJob field to its cron counterpart and you can see exactly what the cluster gives you for free:

- `concurrencyPolicy: Forbid` is the built-in `flock -n`: it prevents overlapping runs with no lock file to manage. `Replace` kills the running job and starts fresh; `Allow` (the default) permits overlap.
- `timeZone` solves the cron timezone ambiguity declaratively, per object.
- `backoffLimit` and `activeDeadlineSeconds` give you retries and timeouts that classic cron never had.
- `startingDeadlineSeconds` controls catch-up after controller downtime, similar in spirit to anacron's missed-run handling.
- Container resource `requests` and `limits` enforce the CPU and memory boundaries that a bare cron job on a shared host cannot.

```bash
# Inspect a CronJob and the Jobs it has spawned
kubectl get cronjob nightly-rollup -n data-platform
kubectl get jobs -n data-platform -l job-name

# Trigger an immediate run for testing, off-schedule
kubectl create job --from=cronjob/nightly-rollup adhoc-rollup -n data-platform

# Read the logs of the most recent run
kubectl logs -n data-platform job/adhoc-rollup
```

A frequent operational surprise: a CronJob whose `concurrencyPolicy` is the default `Allow` will happily stack runs when a job runs long, exactly like cron without `flock`. Set `Forbid` or `Replace` deliberately. The other common failure is forgetting `startingDeadlineSeconds`, which can cause a flood of catch-up jobs after a control-plane outage. The principles are identical to host cron; only the failure surface changed.

## Conclusion

Cron is simple to start and easy to get subtly wrong, and the failures are quiet by design. Internalize a small number of rules and almost every cron incident disappears before it happens.

- **Read the five fields precisely** — especially the day-of-month / day-of-week OR rule and `*/N` steps — and comment every entry in plain language.
- **Know which table you are editing.** User crontabs have five fields; `/etc/crontab` and `/etc/cron.d/*` need a sixth username field, and `/etc/cron.d` filenames must not contain dots.
- **Never trust cron's environment.** It does not source your shell profile and its `PATH` is minimal. Set `PATH`/`SHELL` at the top of the crontab, use absolute paths, escape `%` as `\%`, and keep crontab lines trivial by moving logic into a script.
- **Capture output and alert on failure.** Redirect with `>> file 2>&1`, set `MAILTO`, and add a dead-man's-switch or webhook so a silent failure becomes a loud one.
- **Prevent overlap with `flock -n`**, not a hand-rolled PID file, so the lock releases automatically when the process dies.
- **Run hosts in UTC** to eliminate DST gaps and duplicate runs.
- **Debug in order:** is the daemon running, did the log show the command start, does it run under `env -i`, is the script executable. The cause is almost always near the top.
- **Graduate to the right tool.** Use systemd timers for resource limits, journald logging, missed-run catch-up, and failure handling on a single host; use Kubernetes CronJobs — `concurrencyPolicy`, `timeZone`, `backoffLimit`, `startingDeadlineSeconds` — for the same workloads at cluster scale.

Cron is not going anywhere. Configure it with these rules and it will keep doing exactly what you told it to, quietly and correctly, for the next twenty years.
