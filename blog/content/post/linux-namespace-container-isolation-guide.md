---
title: "Linux Namespaces: Understanding the Isolation Primitives Behind Containers"
date: 2028-12-02T00:00:00-05:00
draft: false
tags: ["Linux", "Namespaces", "Containers", "Security", "Systems Programming"]
categories:
- Linux
- Containers
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep technical guide to all 8 Linux namespace types, unshare and nsenter, creating minimal containers from scratch with clone(2), user namespace UID mapping, time namespaces, and debugging isolation failures."
more_link: "yes"
url: "/linux-namespace-container-isolation-guide/"
---

Containers are not a kernel primitive. They are a composition of at least six Linux namespace types plus cgroups, seccomp, and capabilities. Understanding the underlying primitives is essential for writing container runtimes, diagnosing isolation failures, building security policies, and reasoning about what a compromised container can and cannot touch.

This guide covers every namespace type that Linux provides, the system calls that manipulate them, rootless containers via user namespaces, the new time namespace, and practical debugging techniques.

<!--more-->

# Linux Namespaces: Isolation Primitives Behind Containers

## Section 1: The Eight Namespace Types

| Namespace | Flag           | Kernel Version | What it isolates |
|-----------|---------------|----------------|-----------------|
| Mount     | CLONE_NEWNS   | 2.4.19         | Filesystem mount points |
| UTS       | CLONE_NEWUTS  | 2.6.19         | Hostname and NIS domain name |
| IPC       | CLONE_NEWIPC  | 2.6.19         | System V IPC, POSIX message queues |
| Network   | CLONE_NEWNET  | 2.6.24         | Network devices, stacks, ports |
| PID       | CLONE_NEWPID  | 3.8            | Process ID space |
| User      | CLONE_NEWUSER | 3.8            | User/group IDs |
| Cgroup    | CLONE_NEWCGROUP | 4.6          | cgroup root view |
| Time      | CLONE_NEWTIME | 5.6            | CLOCK_MONOTONIC, CLOCK_BOOTTIME |

Inspect namespaces of a running process:

```bash
# Namespaces of PID 1
ls -la /proc/1/ns/
# lrwxrwxrwx cgroup -> cgroup:[4026531835]
# lrwxrwxrwx ipc    -> ipc:[4026531839]
# lrwxrwxrwx mnt    -> mnt:[4026531840]
# lrwxrwxrwx net    -> net:[4026531992]
# lrwxrwxrwx pid    -> pid:[4026531836]
# lrwxrwxrwx pid_for_children -> pid:[4026531836]
# lrwxrwxrwx time   -> time:[4026531834]
# lrwxrwxrwx time_for_children -> time:[4026531834]
# lrwxrwxrwx user   -> user:[4026531837]
# lrwxrwxrwx uts    -> uts:[4026531838]

# Compare with a container's init process
CONTAINER_PID=$(docker inspect --format '{{.State.Pid}}' my-container)
ls -la /proc/${CONTAINER_PID}/ns/

# See which namespaces differ from PID 1
for ns in /proc/${CONTAINER_PID}/ns/*; do
  nsname=$(basename $ns)
  host=$(readlink /proc/1/ns/$nsname)
  container=$(readlink $ns)
  if [ "$host" != "$container" ]; then
    echo "$nsname is ISOLATED: $container (host: $host)"
  else
    echo "$nsname is SHARED"
  fi
done
```

## Section 2: UTS Namespace — Hostname Isolation

The UTS namespace isolates `hostname` and `domainname`. It is one of the simplest namespaces to experiment with.

```bash
# Create a new UTS namespace in a shell
sudo unshare --uts bash

# Inside the new namespace
hostname
# myhost.example.com

hostname container-host
hostname
# container-host

# Host is unaffected (open another terminal)
hostname
# myhost.example.com

exit
```

In C, this is done with `unshare(CLONE_NEWUTS)`:

```c
// uts_demo.c
#define _GNU_SOURCE
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

int main(void) {
    if (unshare(CLONE_NEWUTS) == -1) {
        perror("unshare");
        exit(1);
    }
    sethostname("container-1", 11);

    char hostname[256];
    gethostname(hostname, sizeof(hostname));
    printf("hostname in new UTS namespace: %s\n", hostname);
    return 0;
}
```

```bash
gcc -o uts_demo uts_demo.c
sudo ./uts_demo
# hostname in new UTS namespace: container-1
```

## Section 3: PID Namespace — Process ID Isolation

A new PID namespace starts its own PID numbering from 1. The first process in the namespace becomes PID 1 (the init process). If it exits, all other processes in the namespace are killed.

```bash
# Create a PID namespace with a bash shell as PID 1
sudo unshare --pid --fork --mount-proc bash

# Inside the new PID namespace
ps aux
# USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND
# root         1  0.0  0.0  22780  5124 pts/1    S    10:00   0:00 bash
# root         6  0.0  0.0  36244  3396 pts/1    R+   10:00   0:00 ps aux

# PID 1 from the host's perspective
cat /proc/1/status | grep NSpid
# NSpid: 1  12345
#            ^--- PID in parent namespace
```

PID namespace nesting: a process can see its own PID and all ancestor namespace PIDs:

```bash
# /proc/PID/status shows NSpid for each nested namespace level
cat /proc/self/status | grep NSpid
# NSpid:	8423	1	    <- PID 8423 in root namespace, PID 1 in child
```

## Section 4: Network Namespace — Network Stack Isolation

Network namespaces are the basis for container networking. Each network namespace has its own:
- Network interfaces (except loopback is created automatically)
- Routing tables
- iptables rules
- Sockets (separate port space)

```bash
# Create two network namespaces and connect them with a veth pair
ip netns add ns1
ip netns add ns2

# Verify
ip netns list
# ns1 (id: 0)
# ns2 (id: 1)

# Create veth pair
ip link add veth1 type veth peer name veth2

# Move each end into its namespace
ip link set veth1 netns ns1
ip link set veth2 netns ns2

# Configure addresses
ip netns exec ns1 ip addr add 192.168.100.1/24 dev veth1
ip netns exec ns2 ip addr add 192.168.100.2/24 dev veth2

ip netns exec ns1 ip link set veth1 up
ip netns exec ns1 ip link set lo up
ip netns exec ns2 ip link set veth2 up
ip netns exec ns2 ip link set lo up

# Test connectivity
ip netns exec ns1 ping -c3 192.168.100.2
# 3 packets transmitted, 3 received, 0% packet loss

# Look at routing tables
ip netns exec ns1 ip route show
# 192.168.100.0/24 dev veth1 proto kernel scope link src 192.168.100.1

# Port space isolation: a server in ns1 on port 80 is invisible from ns2
ip netns exec ns1 python3 -m http.server 80 &
ip netns exec ns2 curl http://192.168.100.1:80  # reachable via veth
# nc -z 127.0.0.1 80 returns failure (loopback is per-namespace)

# Cleanup
ip netns del ns1
ip netns del ns2
```

## Section 5: Mount Namespace — Filesystem Isolation

Mount namespaces provide isolated views of the filesystem. A new mount namespace starts as a copy of the parent's mount tree.

```bash
# Create a minimal rootfs for a container
ROOTFS=$(mktemp -d)
mkdir -p $ROOTFS/{bin,lib,lib64,proc,sys,dev,tmp,etc}

# Copy minimal binaries
cp /bin/bash $ROOTFS/bin/
cp /bin/ls $ROOTFS/bin/
cp /bin/cat $ROOTFS/bin/

# Copy required libraries
ldd /bin/bash | grep -o '/lib[^ ]*' | xargs -I{} cp --parents {} $ROOTFS
ldd /bin/ls   | grep -o '/lib[^ ]*' | xargs -I{} cp --parents {} $ROOTFS

echo "nameserver 1.1.1.1" > $ROOTFS/etc/resolv.conf
echo "container-1" > $ROOTFS/etc/hostname

# Enter a new mount + PID + UTS namespace and chroot
sudo unshare --mount --pid --fork --uts \
  bash -c "
    hostname container-1
    mount -t proc proc $ROOTFS/proc
    mount -t sysfs sysfs $ROOTFS/sys
    mount -t devtmpfs devtmpfs $ROOTFS/dev
    chroot $ROOTFS /bin/bash
  "

# Inside the container
ls /
# bin  dev  etc  lib  lib64  proc  sys  tmp

ps aux
# USER  PID %CPU %MEM  COMMAND
# root    1  0.0  0.0  /bin/bash

# Verify hostname isolation
hostname
# container-1
```

## Section 6: User Namespace — UID/GID Remapping

User namespaces allow an unprivileged user to appear as root inside a namespace. This is the foundation of rootless containers (used by Podman, rootless Docker, and rootless Kubernetes via usernsd).

```bash
# An unprivileged user creates a user namespace where they appear as root
id
# uid=1000(alice) gid=1000(alice)

unshare --user bash

# Inside the user namespace
id
# uid=65534(nobody) gid=65534(nogroup)  <- before mapping is set

# From another shell, set the UID mapping
# Map host UID 1000 -> container UID 0 (root in namespace)
echo "0 1000 1" > /proc/$(pgrep -f "unshare --user" -n)/uid_map
echo "deny"     > /proc/$(pgrep -f "unshare --user" -n)/setgroups
echo "0 1000 1" > /proc/$(pgrep -f "unshare --user" -n)/gid_map

# Now inside the namespace:
id
# uid=0(root) gid=0(root) groups=0(root)  <- root in namespace

# But actual host UID is still 1000
cat /proc/self/status | grep -E "^[UG]id:"
# Uid:	0	0	0	0  <- effective UID in namespace
# But host PID shows: real=1000
```

Writing UID maps programmatically in Go for a rootless container runtime:

```go
// internal/userns/userns.go
package userns

import (
	"fmt"
	"os"
	"path/filepath"
)

// MapRoot maps containerUID (0) to hostUID in a new user namespace.
// Must be called from the parent process after clone/unshare.
func MapRoot(pid int, hostUID, hostGID int) error {
	uidMapPath := filepath.Join("/proc", fmt.Sprintf("%d", pid), "uid_map")
	gidMapPath := filepath.Join("/proc", fmt.Sprintf("%d", pid), "gid_map")
	setgroupsPath := filepath.Join("/proc", fmt.Sprintf("%d", pid), "setgroups")

	// Must write "deny" to setgroups before writing gid_map
	// (required when the calling process lacks CAP_SETGID).
	if err := os.WriteFile(setgroupsPath, []byte("deny"), 0); err != nil {
		return fmt.Errorf("write setgroups: %w", err)
	}

	// uid_map: <containerUID> <hostUID> <count>
	uidMap := fmt.Sprintf("0 %d 1\n", hostUID)
	if err := os.WriteFile(uidMapPath, []byte(uidMap), 0); err != nil {
		return fmt.Errorf("write uid_map: %w", err)
	}

	gidMap := fmt.Sprintf("0 %d 1\n", hostGID)
	if err := os.WriteFile(gidMapPath, []byte(gidMap), 0); err != nil {
		return fmt.Errorf("write gid_map: %w", err)
	}

	return nil
}
```

Larger UID range for full container compatibility:

```bash
# Map 65536 UIDs starting at host UID 100000 to container UIDs 0-65535
echo "0 100000 65536" > /proc/$PID/uid_map
echo "0 100000 65536" > /proc/$PID/gid_map
```

Configure `/etc/subuid` and `/etc/subgid` for subuids (required by newuidmap/newgidmap):

```
# /etc/subuid
alice:100000:65536

# /etc/subgid
alice:100000:65536
```

## Section 7: IPC Namespace — SysV IPC and POSIX MQ Isolation

IPC namespaces isolate System V message queues, semaphores, and shared memory. A process in a new IPC namespace cannot attach to shared memory segments created by processes in another IPC namespace.

```bash
# Create shared memory in the host namespace
ipcs -m
# Create a segment
ipcmk -M 4096
# Shared memory id: 32768

# Enter a new IPC namespace
sudo unshare --ipc bash

# The segment created on the host is invisible
ipcs -m
# ------ Shared Memory Segments --------
# key        shmid      owner      perms      bytes      nattch     status
# (empty)

# Cleanup
ipcrm -m 32768  # on host
```

## Section 8: Cgroup Namespace

The cgroup namespace changes what a process sees at `/proc/self/cgroup`. Without it, a containerized process would see its full cgroup path (e.g., `/kubepods/pod123/container456`). With a cgroup namespace, it sees `/` as its cgroup root.

```bash
# Host view
cat /proc/self/cgroup
# 0::/user.slice/user-1000.slice/session-1.scope

# Inside a container (Docker, with --cgroupns=private)
cat /proc/self/cgroup
# 0::/

# Manually create a cgroup namespace
sudo unshare --cgroup bash
cat /proc/self/cgroup
# 0::/
```

## Section 9: Time Namespace — Clock Isolation

Added in Linux 5.6, the time namespace allows each container to have an independent CLOCK_MONOTONIC and CLOCK_BOOTTIME. This is useful for migrating containers between hosts without disrupting monotonic time assumptions, and for replaying time-sensitive logs.

```bash
# Check if time namespaces are supported
ls /proc/1/ns/time
# /proc/1/ns/time -> time:[4026531834]

# Unshare time namespace
# Note: time namespace can only be created before exec (via clone flags in OCI runtime)
# Shell-level manipulation requires util-linux 2.37+
sudo unshare --time bash

# Set monotonic clock offset inside namespace (requires timens_offsets)
# The offset file is in /proc/PID/timens_offsets
# Format: <clockid> <secs> <nsecs>
# clockid 1 = CLOCK_MONOTONIC, 7 = CLOCK_BOOTTIME
cat /proc/self/timens_offsets
# monotonic           0         0
# boottime            0         0

# Set boottime 1000 seconds in the past
echo "boottime 1000 0" > /proc/self/timens_offsets  # must be before first exec

# Verify
date +%s; cat /proc/uptime
```

Time namespace offsets from a Go program:

```go
// internal/timens/offset.go
package timens

import (
	"fmt"
	"os"
	"path/filepath"
)

const (
	ClockMonotonic = 1
	ClockBoottime  = 7
)

// SetOffset writes a timens offset for a process before it execs into the namespace.
// pid is the PID of the target process (which must be in the new time namespace).
func SetOffset(pid int, clockID int, seconds, nanoseconds int64) error {
	path := filepath.Join("/proc", fmt.Sprintf("%d", pid), "timens_offsets")
	var clockName string
	switch clockID {
	case ClockMonotonic:
		clockName = "monotonic"
	case ClockBoottime:
		clockName = "boottime"
	default:
		return fmt.Errorf("unsupported clock ID: %d", clockID)
	}
	line := fmt.Sprintf("%s %d %d\n", clockName, seconds, nanoseconds)
	return os.WriteFile(path, []byte(line), 0600)
}
```

## Section 10: Building a Minimal Container from Scratch

Combining all namespaces with `clone(2)` in Go using the `syscall` package:

```go
// cmd/minicontainer/main.go
package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintf(os.Stderr, "Usage: minicontainer <rootfs> [cmd [args...]]\n")
		os.Exit(1)
	}

	if os.Args[0] == "/proc/self/exe" && len(os.Args) > 1 && os.Args[1] == "--child" {
		runChild(os.Args[2], os.Args[3:])
		return
	}

	rootfs := os.Args[1]
	cmdArgs := os.Args[2:]
	if len(cmdArgs) == 0 {
		cmdArgs = []string{"/bin/sh"}
	}

	// Re-exec ourselves as the child inside the new namespaces.
	args := append([]string{"/proc/self/exe", "--child", rootfs}, cmdArgs...)
	cmd := &exec.Cmd{
		Path:   "/proc/self/exe",
		Args:   args,
		Stdin:  os.Stdin,
		Stdout: os.Stdout,
		Stderr: os.Stderr,
		SysProcAttr: &syscall.SysProcAttr{
			Cloneflags: syscall.CLONE_NEWUTS |
				syscall.CLONE_NEWIPC |
				syscall.CLONE_NEWPID |
				syscall.CLONE_NEWNS |
				syscall.CLONE_NEWNET |
				syscall.CLONE_NEWUSER,
			UidMappings: []syscall.SysProcIDMap{
				{ContainerID: 0, HostID: os.Getuid(), Size: 1},
			},
			GidMappings: []syscall.SysProcIDMap{
				{ContainerID: 0, HostID: os.Getgid(), Size: 1},
			},
		},
	}

	if err := cmd.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "container error: %v\n", err)
		os.Exit(1)
	}
}

func runChild(rootfs string, cmdArgs []string) {
	// Set hostname
	if err := syscall.Sethostname([]byte("container")); err != nil {
		fmt.Fprintf(os.Stderr, "sethostname: %v\n", err)
	}

	// Mount proc inside rootfs
	procPath := filepath.Join(rootfs, "proc")
	_ = os.MkdirAll(procPath, 0755)
	if err := syscall.Mount("proc", procPath, "proc", 0, ""); err != nil {
		fmt.Fprintf(os.Stderr, "mount proc: %v\n", err)
	}

	// Chroot into rootfs
	if err := syscall.Chroot(rootfs); err != nil {
		fmt.Fprintf(os.Stderr, "chroot: %v\n", err)
		os.Exit(1)
	}
	if err := os.Chdir("/"); err != nil {
		fmt.Fprintf(os.Stderr, "chdir: %v\n", err)
		os.Exit(1)
	}

	// Exec the command
	if len(cmdArgs) == 0 {
		cmdArgs = []string{"/bin/sh"}
	}

	if err := syscall.Exec(cmdArgs[0], cmdArgs, os.Environ()); err != nil {
		fmt.Fprintf(os.Stderr, "exec %s: %v\n", cmdArgs[0], err)
		os.Exit(1)
	}
}
```

```bash
# Build and run
go build -o minicontainer ./cmd/minicontainer

# Create a minimal Alpine rootfs
mkdir /tmp/alpine-rootfs
docker export $(docker create alpine) | tar -C /tmp/alpine-rootfs -xf -

# Run
./minicontainer /tmp/alpine-rootfs /bin/sh

# Inside the container
hostname
# container
ps
#   PID TTY      STAT TIME COMMAND
#     1 pts/0    S    0:00 /bin/sh
#     5 pts/0    R+   0:00 ps
```

## Section 11: nsenter — Entering Existing Namespaces

`nsenter` joins the namespaces of an existing process. This is how `kubectl exec` and `docker exec` work under the hood.

```bash
# Enter all namespaces of a container process
CONTAINER_PID=$(docker inspect --format '{{.State.Pid}}' nginx)

# Enter network namespace only (to run tcpdump on container traffic from host)
nsenter --target $CONTAINER_PID --net -- tcpdump -i eth0 -w /tmp/capture.pcap

# Enter mount + pid namespace (like docker exec)
nsenter --target $CONTAINER_PID --mount --pid -- /bin/bash

# Enter specific namespace by file descriptor
nsenter --net=/proc/$CONTAINER_PID/ns/net -- ip addr show

# Verify you are in the right namespaces
nsenter --target $CONTAINER_PID --mount --pid -- \
  bash -c "ls -la /proc/self/ns && hostname"
```

## Section 12: Debugging Namespace Isolation Failures

### Finding namespace leaks

```bash
# Show all distinct mount namespaces on the system
findmnt -N 1 2>/dev/null
lsns --type mnt

# Show all network namespaces with their processes
lsns --type net -o NS,TYPE,NPROCS,PID,PPID,COMMAND

# Find processes that share a namespace with a specific container
CONTAINER_NET_NS=$(readlink /proc/$CONTAINER_PID/ns/net)
for pid in $(ls /proc | grep -E '^[0-9]+$'); do
  ns=$(readlink /proc/$pid/ns/net 2>/dev/null)
  if [ "$ns" = "$CONTAINER_NET_NS" ]; then
    echo "PID $pid shares net namespace with container: $(cat /proc/$pid/comm)"
  fi
done
```

### Namespace persistence via bind mounts

```bash
# Keep a namespace alive after the process exits (useful for network ns)
touch /run/netns/my-persistent-ns
mount --bind /proc/$SOME_PID/ns/net /run/netns/my-persistent-ns

# Rejoin it later
ip netns exec my-persistent-ns ip addr show
nsenter --net=/run/netns/my-persistent-ns -- ip route show

# Clean up
umount /run/netns/my-persistent-ns
rm /run/netns/my-persistent-ns
```

### Checking OCI runtime namespace configuration

```bash
# Inspect the namespace config of a running container
cat /run/containerd/io.containerd.runtime.v2.task/default/$(docker ps -q)/config.json \
  | python3 -m json.tool | grep -A20 '"namespaces"'
```

The OCI runtime spec `config.json` will show entries like:

```json
{
  "namespaces": [
    {"type": "pid"},
    {"type": "network", "path": "/run/netns/my-cni-ns"},
    {"type": "ipc"},
    {"type": "uts"},
    {"type": "mount"},
    {"type": "cgroup"}
  ]
}
```

A missing `network` entry means the container shares the host network stack — a critical security misconfiguration.

Understanding Linux namespaces at this level allows you to audit container runtimes, write custom isolation tools, diagnose why a process can see resources it should not, and reason about the actual security boundary between a container and the host kernel. The kernel provides the primitives; container runtimes are software that composes them.
