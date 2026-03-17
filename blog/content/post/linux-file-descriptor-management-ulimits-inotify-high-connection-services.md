---
title: "Linux File Descriptor Management: ulimits, inotify, and High-Connection Services"
date: 2030-08-17T00:00:00-05:00
draft: false
tags: ["Linux", "File Descriptors", "ulimits", "inotify", "epoll", "Performance", "Kubernetes"]
categories:
- Linux
- Performance
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Linux file descriptor management guide covering system-wide and per-process fd limits, inotify instance and watch limits, epoll-based event loops, SO_REUSEPORT for multi-process listening, and tuning fd limits for high-connection Kubernetes services."
more_link: "yes"
url: "/linux-file-descriptor-management-ulimits-inotify-high-connection-services/"
---

File descriptor exhaustion is one of the most common causes of production service outages in high-connection environments. Every TCP connection, open file, socket, pipe, epoll file descriptor, inotify instance, and timer descriptor consumes one entry from a process's file descriptor table. When that table fills, any operation that allocates a new file descriptor — `accept(2)`, `open(2)`, `socket(2)` — returns `EMFILE (Too many open files)`, and the service begins refusing new connections or crashing.

<!--more-->

## Understanding File Descriptor Limits

### System-Wide Limit

Linux enforces a maximum total number of open file descriptors across all processes system-wide:

```bash
# View current system-wide file descriptor limit
cat /proc/sys/fs/file-max
# 9223372036854775807  (effectively unlimited on modern kernels)

# View current usage: open fds, allowed fds, maximum fds
cat /proc/sys/fs/file-nr
# 38912   0   9223372036854775807
# (open) (free-slots) (max)

# Set a lower system-wide limit for resource-constrained environments
sysctl -w fs.file-max=2097152
echo "fs.file-max = 2097152" >> /etc/sysctl.d/99-fd-limits.conf
```

### Per-Process Limits (ulimit)

The per-process limit is controlled by the `RLIMIT_NOFILE` resource limit:

```bash
# Check current soft and hard limits for the running shell
ulimit -Sn   # Soft limit (enforced)
ulimit -Hn   # Hard limit (ceiling for soft)

# Common defaults
# 1024 (soft) / 4096 (hard) for unprivileged users
# 65536 / 65536 for many container images

# Raise soft limit to hard limit in the current shell
ulimit -Sn $(ulimit -Hn)

# Raise both soft and hard limits (requires root or CAP_SYS_RESOURCE)
ulimit -n 1048576
```

### Setting Limits Persistently via /etc/security/limits.conf

```bash
# /etc/security/limits.conf
# domain       type    item    value
*               soft    nofile  65536
*               hard    nofile  1048576
root            soft    nofile  65536
root            hard    nofile  1048576
```

Limits in `/etc/security/limits.conf` apply to interactive login sessions via PAM. For system services, use systemd unit file directives.

### Systemd Service File Limits

```ini
# /etc/systemd/system/myservice.service
[Service]
ExecStart=/usr/local/bin/myservice
LimitNOFILE=1048576
LimitNPROC=65536
```

```bash
# Apply changes without restarting the service
systemctl daemon-reload
systemctl restart myservice

# Verify the effective limit for a running process
cat /proc/$(systemctl show --property MainPID myservice | cut -d= -f2)/limits | grep "Max open"
```

---

## Diagnosing File Descriptor Exhaustion

### Finding FD-Heavy Processes

```bash
# Top processes by open file descriptor count
for pid in /proc/[0-9]*; do
    count=$(ls "$pid/fd" 2>/dev/null | wc -l)
    name=$(cat "$pid/comm" 2>/dev/null)
    echo "$count $name ($(basename $pid))"
done | sort -rn | head -20
```

### Viewing Open FDs for a Specific Process

```bash
# List all open file descriptors for PID 12345
ls -la /proc/12345/fd | head -50

# Count and categorize
ls /proc/12345/fd | wc -l                 # Total count
ls -la /proc/12345/fd | grep socket | wc -l   # Sockets
ls -la /proc/12345/fd | grep pipe | wc -l     # Pipes

# Detailed FD information via fdinfo
cat /proc/12345/fdinfo/0    # stdin
cat /proc/12345/fdinfo/1    # stdout
```

### Using lsof

```bash
# Count open FDs per process
lsof -n | awk '{print $1}' | sort | uniq -c | sort -rn | head -20

# All open network connections for a process
lsof -p 12345 -i

# All processes with connections to a specific port
lsof -i :8080 -n -P
```

---

## inotify Limits

inotify is the Linux kernel's filesystem event notification mechanism. It is used by file synchronization tools, configuration watchers (like Kubernetes controllers), and development servers. Each inotify instance and watch consumes kernel memory and counts against configurable limits.

### inotify Kernel Parameters

```bash
# Maximum number of inotify instances per user
cat /proc/sys/fs/inotify/max_user_instances
# 128 (default — far too low for Kubernetes nodes)

# Maximum number of watches per inotify instance
cat /proc/sys/fs/inotify/max_user_watches
# 8192 (default — too low for many applications)

# Maximum number of events in the inotify event queue
cat /proc/sys/fs/inotify/max_queued_events
# 16384
```

### Kubernetes Node inotify Tuning

On a Kubernetes node running many pods, each pod's container runtime creates inotify watches for configuration files, Kubernetes ConfigMaps (via projected volumes), and application-specific watches. The default limits are quickly exhausted:

```bash
# Symptoms of inotify limit exhaustion
# dmesg: "inotify watches limit exceeded"
# Application error: "too many open files" or "no space left on device" (ENOSPC)
# Kubernetes pod log watchers stop working

# Recommended settings for Kubernetes nodes
sysctl -w fs.inotify.max_user_instances=8192
sysctl -w fs.inotify.max_user_watches=524288
sysctl -w fs.inotify.max_queued_events=32768

# Persist via sysctl.d
cat > /etc/sysctl.d/99-inotify.conf <<'EOF'
fs.inotify.max_user_instances = 8192
fs.inotify.max_user_watches = 524288
fs.inotify.max_queued_events = 32768
EOF
sysctl --system
```

### Identifying inotify Watch Users

```bash
# Find processes with active inotify watches
grep -r inotify /proc/*/fdinfo/ 2>/dev/null | \
    awk -F'/' '{print $3}' | sort -u | while read pid; do
    watches=$(grep "^inotify" /proc/$pid/fdinfo/* 2>/dev/null | wc -l)
    name=$(cat /proc/$pid/comm 2>/dev/null)
    echo "$watches $name ($pid)"
done | sort -rn | head -20
```

### Monitoring inotify Usage

```bash
# Check current inotify watch count (requires root)
find /proc/*/fdinfo -name '*' -exec grep -l "inotify" {} \; 2>/dev/null | \
    xargs grep "^inotify" 2>/dev/null | wc -l
```

---

## epoll: Scalable I/O Event Notification

`epoll` is the Linux mechanism for monitoring thousands of file descriptors efficiently. It is the foundation of high-performance network servers, and each epoll file descriptor itself consumes one FD from the process's table.

### epoll Architecture

```
Process FD table
├── fd 0: stdin
├── fd 1: stdout
├── fd 2: stderr
├── fd 3: epoll_fd   ← one FD for the entire event loop
├── fd 4: server socket (LISTEN)
├── fd 5: client connection 1   ─┐
├── fd 6: client connection 2    ├─ registered with epoll_fd
├── fd 7: client connection 3   ─┘
└── ...
```

### epoll-Based Event Loop in Go

Go's runtime uses epoll internally, but understanding direct epoll usage helps diagnose issues:

```go
// pkg/eventloop/server.go
package eventloop

import (
    "fmt"
    "net"
    "syscall"
    "unsafe"
)

const maxEvents = 1024

// EpollServer demonstrates a raw epoll-based TCP server.
// In production Go, use net.Listen and goroutines — the runtime
// manages epoll internally. This example illustrates the FD lifecycle.
type EpollServer struct {
    epollFD   int
    listenFD  int
    conns     map[int]net.Conn
}

func New(listenAddr string) (*EpollServer, error) {
    // Create epoll instance
    epollFD, err := syscall.EpollCreate1(syscall.EPOLL_CLOEXEC)
    if err != nil {
        return nil, fmt.Errorf("creating epoll: %w", err)
    }

    // Create and bind listening socket
    listenFD, err := syscall.Socket(syscall.AF_INET6, syscall.SOCK_STREAM|syscall.SOCK_NONBLOCK|syscall.SOCK_CLOEXEC, 0)
    if err != nil {
        syscall.Close(epollFD)
        return nil, fmt.Errorf("creating socket: %w", err)
    }

    // SO_REUSEADDR to reuse port on restart
    if err := syscall.SetsockoptInt(listenFD, syscall.SOL_SOCKET, syscall.SO_REUSEADDR, 1); err != nil {
        syscall.Close(epollFD)
        syscall.Close(listenFD)
        return nil, fmt.Errorf("setting SO_REUSEADDR: %w", err)
    }

    // Register listening socket with epoll
    event := &syscall.EpollEvent{
        Events: syscall.EPOLLIN,
        Fd:     int32(listenFD),
    }
    if err := syscall.EpollCtl(epollFD, syscall.EPOLL_CTL_ADD, listenFD, event); err != nil {
        syscall.Close(epollFD)
        syscall.Close(listenFD)
        return nil, fmt.Errorf("registering listen fd with epoll: %w", err)
    }

    return &EpollServer{
        epollFD:  epollFD,
        listenFD: listenFD,
        conns:    make(map[int]net.Conn),
    }, nil
}

func (s *EpollServer) Close() {
    syscall.Close(s.epollFD)
    syscall.Close(s.listenFD)
}
```

---

## SO_REUSEPORT for Multi-Process Listening

`SO_REUSEPORT` allows multiple processes or threads to bind to the same TCP port. The kernel distributes incoming connections across all bound sockets using a hash of the source IP and port. This eliminates the single-process accept bottleneck in multi-core systems.

### Setting SO_REUSEPORT in Go

```go
// pkg/listener/reuseport.go
package listener

import (
    "context"
    "fmt"
    "net"
    "syscall"

    "golang.org/x/sys/unix"
)

// ListenReusePort creates a TCP listener with SO_REUSEPORT enabled.
// Multiple calls to ListenReusePort on the same address create independent
// listener sockets; the kernel distributes connections across them.
func ListenReusePort(network, addr string) (net.Listener, error) {
    lc := &net.ListenConfig{
        Control: func(network, address string, c syscall.RawConn) error {
            return c.Control(func(fd uintptr) {
                if err := unix.SetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_REUSEPORT, 1); err != nil {
                    // Log but do not fail — SO_REUSEPORT is an optimization
                    fmt.Printf("warn: SO_REUSEPORT unavailable: %v\n", err)
                }
            })
        },
    }
    return lc.Listen(context.Background(), network, addr)
}
```

### Multi-Worker Server Using SO_REUSEPORT

```go
// cmd/server/main.go
package main

import (
    "fmt"
    "net/http"
    "os"
    "runtime"
    "sync"

    "github.com/example/service/pkg/listener"
)

func main() {
    workers := runtime.NumCPU()
    var wg sync.WaitGroup

    for i := 0; i < workers; i++ {
        wg.Add(1)
        go func(workerID int) {
            defer wg.Done()

            ln, err := listener.ListenReusePort("tcp", ":8080")
            if err != nil {
                fmt.Fprintf(os.Stderr, "worker %d: listen error: %v\n", workerID, err)
                return
            }
            defer ln.Close()

            srv := &http.Server{Handler: http.DefaultServeMux}
            if err := srv.Serve(ln); err != nil {
                fmt.Fprintf(os.Stderr, "worker %d: serve error: %v\n", workerID, err)
            }
        }(i)
    }

    wg.Wait()
}
```

---

## Kubernetes Container FD Limits

Kubernetes containers inherit file descriptor limits from the container runtime. Containerd and CRI-O set container limits based on the node's systemd configuration.

### Setting FD Limits in Pod Specs

Kubernetes does not expose `LimitNOFILE` directly in pod specs. The limit is inherited from the container runtime. To set per-container limits, use an init container or `ulimit` in the container entrypoint:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: high-connection-service
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: high-connection-service
  template:
    spec:
      initContainers:
        - name: set-fd-limits
          image: busybox:1.36
          securityContext:
            privileged: true
          command:
            - sh
            - -c
            - |
              ulimit -n 1048576
              echo "File descriptor limit set"
      containers:
        - name: app
          image: myregistry.example.com/high-connection-service:latest
          securityContext:
            capabilities:
              add:
                - SYS_RESOURCE
          command:
            - sh
            - -c
            - |
              ulimit -n 1048576
              exec /app/server
```

### Node-Level FD Tuning via DaemonSet

For Kubernetes nodes, apply sysctl settings via a privileged DaemonSet or via node configuration management:

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-fd-tuning
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: node-fd-tuning
  template:
    metadata:
      labels:
        app: node-fd-tuning
    spec:
      hostPID: true
      hostIPC: true
      hostNetwork: true
      tolerations:
        - operator: Exists
      initContainers:
        - name: sysctl-tuning
          image: busybox:1.36
          securityContext:
            privileged: true
          command:
            - sh
            - -c
            - |
              sysctl -w fs.file-max=2097152
              sysctl -w fs.inotify.max_user_instances=8192
              sysctl -w fs.inotify.max_user_watches=524288
              sysctl -w fs.inotify.max_queued_events=32768
              sysctl -w net.core.somaxconn=65535
              sysctl -w net.ipv4.tcp_max_syn_backlog=65535
              echo "Node sysctl tuning complete"
      containers:
        - name: pause
          image: gcr.io/google-containers/pause:3.9
          resources:
            requests:
              cpu: "10m"
              memory: "10Mi"
```

### Kubernetes Sysctl Pod Security

Kubernetes also supports safe and unsafe sysctls directly in pod specs. Safe sysctls (namespaced) can be set without special node configuration:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: high-connection-pod
spec:
  securityContext:
    sysctls:
      - name: net.core.somaxconn
        value: "65535"
      - name: net.ipv4.tcp_fin_timeout
        value: "15"
  containers:
    - name: app
      image: myregistry.example.com/app:latest
```

---

## Connection Limit Monitoring

### Prometheus Node Exporter Metrics

```yaml
# Alerting rules for FD exhaustion
groups:
  - name: fd-limits
    rules:
      - alert: ProcessFDUsageHigh
        expr: |
          (process_open_fds / process_max_fds) > 0.80
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Process {{ $labels.job }} on {{ $labels.instance }} is using >80% of its file descriptor limit"

      - alert: ProcessFDUsageCritical
        expr: |
          (process_open_fds / process_max_fds) > 0.95
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Process {{ $labels.job }} on {{ $labels.instance }} is near file descriptor exhaustion"

      - alert: NodeInotifyWatchesHigh
        expr: |
          node_filesystem_files{mountpoint="/"} / node_filesystem_files_free{mountpoint="/"} > 0.90
        for: 10m
        labels:
          severity: warning
```

### Application-Level FD Metrics in Go

```go
// pkg/metrics/fd.go
package metrics

import (
    "os"
    "strconv"
    "syscall"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    openFDs = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "process_open_fds",
        Help: "Number of currently open file descriptors",
    })

    maxFDs = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "process_max_fds",
        Help: "Maximum number of open file descriptors",
    })
)

func UpdateFDMetrics() {
    // Count open FDs
    dir, err := os.Open("/proc/self/fd")
    if err == nil {
        entries, _ := dir.Readdirnames(-1)
        dir.Close()
        openFDs.Set(float64(len(entries)))
    }

    // Get max FDs
    var rLimit syscall.Rlimit
    if err := syscall.Getrlimit(syscall.RLIMIT_NOFILE, &rLimit); err == nil {
        maxFDs.Set(float64(rLimit.Cur))
    }
}
```

---

## Production Checklist

```bash
# 1. Verify node-level limits
cat /proc/sys/fs/file-max
cat /proc/sys/fs/inotify/max_user_instances
cat /proc/sys/fs/inotify/max_user_watches

# 2. Verify service-level limits
systemctl show myservice | grep -i limit
cat /proc/$(systemctl show --property MainPID myservice | cut -d= -f2)/limits

# 3. Monitor FD usage under load
watch -n 1 "cat /proc/\$(pgrep -f myservice | head -1)/fd | wc -l"

# 4. Check for EMFILE errors in application logs
journalctl -u myservice | grep -i "too many open files\|EMFILE"

# 5. Verify inotify limits are not exhausted
dmesg | grep inotify

# 6. Check SO_REUSEPORT is in use (optional)
ss -tlnp | grep :8080
```

---

## Conclusion

File descriptor management is foundational infrastructure knowledge for any team operating high-connection services. The combination of per-process ulimits, system-wide `fs.file-max`, inotify instance and watch limits, and epoll FD overhead creates a layered constraint that each layer must be tuned independently. For Kubernetes environments, node-level sysctl tuning via DaemonSet and container entrypoint ulimit configuration are the primary levers. Monitoring FD usage with Prometheus and alerting before exhaustion — rather than after — converts a hard-to-diagnose crash into a routine tuning exercise.
