---
title: "Linux inotify and fanotify: File System Event Monitoring, inotify Limits, fanotify Permission Events, and Container Use Cases"
date: 2032-03-06T00:00:00-05:00
draft: false
tags: ["Linux", "inotify", "fanotify", "Kernel", "Containers", "Security", "File System"]
categories:
- Linux
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Linux file system event monitoring: inotify architecture and limits, fanotify permission events for security enforcement, performance characteristics, and production container monitoring patterns."
more_link: "yes"
url: "/linux-inotify-fanotify-filesystem-event-monitoring-container-use-cases/"
---

File system event monitoring sits at the intersection of security, compliance, and operational tooling. inotify has been the workhorse since Linux 2.6.13, but its per-process watch limit and inability to intercept file operations make it unsuitable for security enforcement. fanotify, available since Linux 2.6.37 and significantly enhanced in 5.x kernels, fills this gap with permission events, filesystem-wide monitoring, and container-aware namespacing. This post covers both APIs in depth, with production-ready C and Go implementations.

<!--more-->

# Linux inotify and fanotify: File System Event Monitoring, inotify Limits, fanotify Permission Events, and Container Use Cases

## inotify Architecture

### The Watch Descriptor Model

inotify uses a file descriptor-based model where each monitored path requires a watch descriptor (WD). Events are delivered as binary records through a read() call on the inotify file descriptor.

```c
#include <sys/inotify.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>

#define EVENT_BUF_LEN (1024 * (sizeof(struct inotify_event) + NAME_MAX + 1))

struct inotify_event {
    int      wd;       /* Watch descriptor */
    uint32_t mask;     /* Event mask */
    uint32_t cookie;   /* Unique identifier for IN_MOVED_FROM/IN_MOVED_TO pairs */
    uint32_t len;      /* Length of name field */
    char     name[];   /* Optional null-terminated filename */
};

int main(int argc, char *argv[]) {
    if (argc < 2) {
        fprintf(stderr, "Usage: %s <path>\n", argv[0]);
        return 1;
    }

    // Create inotify instance
    int ifd = inotify_init1(IN_NONBLOCK | IN_CLOEXEC);
    if (ifd == -1) {
        perror("inotify_init1");
        return 1;
    }

    // Add watch: monitor all events on the path
    int wd = inotify_add_watch(
        ifd,
        argv[1],
        IN_CREATE | IN_DELETE | IN_MODIFY | IN_MOVED_FROM | IN_MOVED_TO |
        IN_ATTRIB | IN_OPEN | IN_CLOSE_WRITE | IN_ACCESS
    );
    if (wd == -1) {
        perror("inotify_add_watch");
        close(ifd);
        return 1;
    }

    printf("Watching %s (wd=%d, ifd=%d)\n", argv[1], wd, ifd);

    char buf[EVENT_BUF_LEN];
    for (;;) {
        ssize_t len = read(ifd, buf, EVENT_BUF_LEN);
        if (len == -1 && errno == EAGAIN) {
            // Non-blocking: no events available
            usleep(10000);
            continue;
        }
        if (len == -1) {
            perror("read");
            break;
        }

        // Process events (events are variable-length, must walk the buffer)
        for (char *ptr = buf; ptr < buf + len; ) {
            struct inotify_event *event = (struct inotify_event *)ptr;
            print_event(event);
            ptr += sizeof(struct inotify_event) + event->len;
        }
    }

    inotify_rm_watch(ifd, wd);
    close(ifd);
    return 0;
}

static void print_event(const struct inotify_event *e) {
    const char *name = e->len > 0 ? e->name : "";

    if (e->mask & IN_CREATE)      printf("CREATE     %s\n", name);
    if (e->mask & IN_DELETE)      printf("DELETE     %s\n", name);
    if (e->mask & IN_MODIFY)      printf("MODIFY     %s\n", name);
    if (e->mask & IN_MOVED_FROM)  printf("MOVED_FROM %s (cookie=%u)\n", name, e->cookie);
    if (e->mask & IN_MOVED_TO)    printf("MOVED_TO   %s (cookie=%u)\n", name, e->cookie);
    if (e->mask & IN_ATTRIB)      printf("ATTRIB     %s\n", name);
    if (e->mask & IN_OPEN)        printf("OPEN       %s\n", name);
    if (e->mask & IN_CLOSE_WRITE) printf("CLOSE_WRITE %s\n", name);
    if (e->mask & IN_ACCESS)      printf("ACCESS     %s\n", name);
    if (e->mask & IN_ISDIR)       printf("  (is directory)\n");
    if (e->mask & IN_OVERFLOW)    fprintf(stderr, "EVENT QUEUE OVERFLOW\n");
}
```

### inotify Event Flags Reference

| Flag | Value | Description |
|------|-------|-------------|
| IN_ACCESS | 0x00000001 | File accessed (read) |
| IN_MODIFY | 0x00000002 | File modified (write/truncate) |
| IN_ATTRIB | 0x00000004 | Metadata changed (permissions, timestamps, xattrs) |
| IN_CLOSE_WRITE | 0x00000008 | Writable file closed |
| IN_CLOSE_NOWRITE | 0x00000010 | Non-writable file closed |
| IN_OPEN | 0x00000020 | File opened |
| IN_MOVED_FROM | 0x00000040 | File moved away from watched dir |
| IN_MOVED_TO | 0x00000080 | File moved into watched dir |
| IN_CREATE | 0x00000100 | File/dir created in watched dir |
| IN_DELETE | 0x00000200 | File/dir deleted from watched dir |
| IN_DELETE_SELF | 0x00000400 | Watched file/dir deleted |
| IN_MOVE_SELF | 0x00000800 | Watched file/dir moved |
| IN_UNMOUNT | 0x00002000 | Filesystem containing watched object unmounted |
| IN_Q_OVERFLOW | 0x00004000 | Event queue overflowed (drop risk) |
| IN_IGNORED | 0x00008000 | Watch removed |
| IN_ONLYDIR | 0x01000000 | Only watch if path is a directory (flag) |
| IN_DONT_FOLLOW | 0x02000000 | Don't follow symlinks (flag) |
| IN_EXCL_UNLINK | 0x04000000 | Exclude events on unlinked children (flag) |
| IN_MASK_ADD | 0x20000000 | Add to existing watch mask (flag) |
| IN_ISDIR | 0x40000000 | Event subject is a directory |
| IN_ONESHOT | 0x80000000 | Auto-remove watch after one event (flag) |

### The inotify Limits Problem

inotify has three critical kernel parameters that limit scalability:

```bash
# Current limits
cat /proc/sys/fs/inotify/max_user_watches    # Default: 8192
cat /proc/sys/fs/inotify/max_user_instances  # Default: 128
cat /proc/sys/fs/inotify/max_queued_events   # Default: 16384

# Each inotify watch consumes ~540 bytes of kernel memory
# 8192 watches * 540 bytes = ~4.3 MB per user (across all their inotify instances)
# 1,000,000 watches * 540 bytes = ~540 MB

# Check current watch usage
cat /proc/<pid>/fdinfo/<inotify-fd> | grep wd_count

# Count watches across all processes
for pid in /proc/[0-9]*; do
    for fd in $pid/fd/*; do
        if readlink -q $fd | grep -q inotify; then
            cat $pid/fdinfo/$(basename $fd) 2>/dev/null
        fi
    done
done | grep -c "^wd:"
```

When the watch limit is hit, `inotify_add_watch()` returns ENOSPC:

```
errno: ENOSPC (28): No space left on device
```

This is one of the most confusing errors in Linux development - it looks like a disk space error but is actually a watch count limit.

### Tuning inotify Limits

```bash
# Temporary increase (lost on reboot)
sysctl -w fs.inotify.max_user_watches=524288
sysctl -w fs.inotify.max_user_instances=512
sysctl -w fs.inotify.max_queued_events=131072

# Permanent (add to /etc/sysctl.d/99-inotify.conf)
cat <<'EOF' > /etc/sysctl.d/99-inotify.conf
# inotify limits for production Kubernetes nodes
# Each watch uses ~540 bytes of kernel memory
# 524288 watches = ~283 MB kernel memory
fs.inotify.max_user_watches = 524288
fs.inotify.max_user_instances = 512
fs.inotify.max_queued_events = 131072
EOF
sysctl --system

# Kubernetes DaemonSet to apply on all nodes
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: sysctl-tuner
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: sysctl-tuner
  template:
    spec:
      hostPID: true
      hostNetwork: true
      initContainers:
      - name: sysctl
        image: busybox:1.36
        securityContext:
          privileged: true
        command:
        - sh
        - -c
        - |
          sysctl -w fs.inotify.max_user_watches=524288
          sysctl -w fs.inotify.max_user_instances=512
          sysctl -w fs.inotify.max_queued_events=131072
      containers:
      - name: pause
        image: gcr.io/google-containers/pause:3.9
```

### Recursive Directory Watching

inotify does NOT support recursive watching natively. You must add a watch for each subdirectory:

```go
package main

import (
    "fmt"
    "io/fs"
    "path/filepath"

    "github.com/fsnotify/fsnotify"
)

func watchRecursive(root string) (*fsnotify.Watcher, error) {
    watcher, err := fsnotify.NewWatcher()
    if err != nil {
        return nil, fmt.Errorf("creating watcher: %w", err)
    }

    // Walk and add all directories
    err = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
        if err != nil {
            return err
        }
        if d.IsDir() {
            if err := watcher.Add(path); err != nil {
                return fmt.Errorf("watching %s: %w", path, err)
            }
        }
        return nil
    })
    if err != nil {
        watcher.Close()
        return nil, err
    }

    // Handle new directories as they are created
    go func() {
        for event := range watcher.Events {
            if event.Has(fsnotify.Create) {
                // Check if it's a directory and add a watch
                info, err := filepath.Lstat(event.Name)
                if err == nil && info.IsDir() {
                    watcher.Add(event.Name)
                }
            }
        }
    }()

    return watcher, nil
}
```

## fanotify Architecture

### How fanotify Differs from inotify

| Feature | inotify | fanotify |
|---------|---------|---------|
| Scope | Per-path watches | Mount-point or filesystem-wide |
| Recursive | No (must add each dir) | Yes (entire mount subtree) |
| Permission events | No (notification only) | Yes (can deny operations) |
| File identity | Path + filename | File descriptor (inode-stable) |
| Kernel versions | 2.6.13+ | 2.6.37+, enhanced in 5.1-5.17+ |
| Required capability | None | CAP_SYS_ADMIN (or CAP_SYS_PTRACE for limited use) |
| PID of operation | No | Yes |

### fanotify Permission Events

fanotify's killer feature is permission events. The monitoring process receives the event, inspects the file, and either allows or denies the operation before it completes.

```c
#include <sys/fanotify.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <string.h>
#include <errno.h>
#include <limits.h>

#define BUF_SIZE 8192

int main(void) {
    // FAN_CLASS_CONTENT: permission events for files being accessed
    // FAN_CLOEXEC: close fd on exec
    // FAN_NONBLOCK: non-blocking reads
    int fan_fd = fanotify_init(
        FAN_CLASS_CONTENT | FAN_CLOEXEC | FAN_NONBLOCK | FAN_REPORT_FID,
        O_RDONLY | O_LARGEFILE | O_CLOEXEC | O_NOATIME
    );
    if (fan_fd == -1) {
        perror("fanotify_init");
        fprintf(stderr, "Note: fanotify requires CAP_SYS_ADMIN\n");
        return 1;
    }

    // Mark the entire filesystem (not just a directory)
    // FAN_MARK_FILESYSTEM: watch all mounts of this filesystem type
    int ret = fanotify_mark(
        fan_fd,
        FAN_MARK_ADD | FAN_MARK_FILESYSTEM,
        FAN_OPEN_PERM | FAN_ACCESS_PERM,    // Permission events
        AT_FDCWD,
        "/"    // Root of the filesystem to watch
    );
    if (ret == -1) {
        perror("fanotify_mark");
        close(fan_fd);
        return 1;
    }

    char buf[BUF_SIZE];
    for (;;) {
        ssize_t len = read(fan_fd, buf, BUF_SIZE);
        if (len == -1) {
            if (errno == EAGAIN) {
                usleep(1000);
                continue;
            }
            perror("read");
            break;
        }

        for (struct fanotify_event_metadata *meta =
                (struct fanotify_event_metadata *)buf;
             FAN_EVENT_OK(meta, len);
             meta = FAN_EVENT_NEXT(meta, len))
        {
            if (meta->vers < FANOTIFY_METADATA_VERSION) {
                fprintf(stderr, "Unexpected fanotify metadata version\n");
                break;
            }

            if (meta->fd < 0) {
                // Queue overflow or other error
                if (meta->fd == FAN_NOFD)
                    fprintf(stderr, "fanotify queue overflow\n");
                continue;
            }

            // Resolve the file path from the file descriptor
            char path[PATH_MAX];
            char fd_path[32];
            snprintf(fd_path, sizeof(fd_path), "/proc/self/fd/%d", meta->fd);
            ssize_t path_len = readlink(fd_path, path, sizeof(path) - 1);
            if (path_len > 0) {
                path[path_len] = '\0';
            } else {
                strcpy(path, "<unknown>");
            }

            printf("Event: pid=%d fd=%d mask=0x%llx path=%s\n",
                   meta->pid, meta->fd,
                   (unsigned long long)meta->mask, path);

            // Permission decision
            if (meta->mask & (FAN_OPEN_PERM | FAN_ACCESS_PERM)) {
                struct fanotify_response response = {
                    .fd       = meta->fd,
                    .response = FAN_ALLOW,  // Default: allow
                };

                // Example policy: deny access to /etc/shadow by non-root
                if (strstr(path, "/etc/shadow") && meta->pid != 0) {
                    // Verify the process is not root
                    char proc_status[64];
                    snprintf(proc_status, sizeof(proc_status),
                             "/proc/%d/status", meta->pid);
                    FILE *f = fopen(proc_status, "r");
                    if (f) {
                        char line[256];
                        while (fgets(line, sizeof(line), f)) {
                            if (strncmp(line, "Uid:", 4) == 0) {
                                int uid;
                                sscanf(line + 4, "%d", &uid);
                                if (uid != 0) {
                                    response.response = FAN_DENY;
                                    printf("DENIED: pid=%d accessing %s\n",
                                           meta->pid, path);
                                }
                                break;
                            }
                        }
                        fclose(f);
                    }
                }

                write(fan_fd, &response, sizeof(response));
            }

            close(meta->fd);
        }
    }

    close(fan_fd);
    return 0;
}
```

### fanotify with FAN_REPORT_FID (Linux 5.1+)

`FAN_REPORT_FID` enables file ID reporting without requiring an open file descriptor. This is critical for watching large directory trees where opening a FD per event would exhaust the process FD limit.

```c
// With FAN_REPORT_FID, events include file_handle instead of fd
struct fanotify_event_info_fid {
    struct fanotify_event_info_header hdr;
    __kernel_fsid_t fsid;           // Filesystem ID
    unsigned char file_handle[];    // Opaque file handle (variable size)
};

// Open a file by its handle (for inspection or path resolution)
int open_by_handle(int mount_fd, struct file_handle *fh) {
    return open_by_handle_at(mount_fd, fh, O_RDONLY | O_PATH | O_NONBLOCK);
}
```

### fanotify Filesystem-Wide Watch

```c
// Watch all file opens on the root filesystem
fanotify_mark(
    fan_fd,
    FAN_MARK_ADD | FAN_MARK_FILESYSTEM,
    FAN_OPEN | FAN_CLOSE_WRITE | FAN_CREATE | FAN_DELETE |
    FAN_RENAME,           // Linux 5.17+: atomic rename events
    AT_FDCWD,
    "/"
);

// Watch a specific mount
fanotify_mark(
    fan_fd,
    FAN_MARK_ADD | FAN_MARK_MOUNT,
    FAN_OPEN | FAN_MODIFY,
    AT_FDCWD,
    "/data"
);

// Ignore events from specific subtrees (allow-list approach)
fanotify_mark(
    fan_fd,
    FAN_MARK_ADD | FAN_MARK_IGNORED_MASK,
    FAN_OPEN | FAN_MODIFY,
    AT_FDCWD,
    "/proc"
);
fanotify_mark(
    fan_fd,
    FAN_MARK_ADD | FAN_MARK_IGNORED_MASK,
    FAN_OPEN | FAN_MODIFY,
    AT_FDCWD,
    "/sys"
);
```

## Go Implementation: Production File Watcher

### inotify-Based Audit Logger

```go
package audit

import (
    "context"
    "fmt"
    "log/slog"
    "os"
    "path/filepath"
    "strings"
    "sync"
    "time"

    "github.com/fsnotify/fsnotify"
)

// AuditEvent represents a file system event for audit logging
type AuditEvent struct {
    Time      time.Time
    Operation string
    Path      string
    PID       int    // Not available with inotify
    Hostname  string
}

// FileAuditor monitors file system events and emits structured audit logs
type FileAuditor struct {
    watcher    *fsnotify.Watcher
    logger     *slog.Logger
    rules      []AuditRule
    eventCh    chan AuditEvent
    mu         sync.RWMutex
    watchedDirs map[string]bool
}

// AuditRule defines what to watch and how to classify events
type AuditRule struct {
    Path       string
    Operations []string  // "read", "write", "create", "delete", "rename"
    Recurse    bool
    Exclude    []string  // Path prefixes to exclude
}

func NewFileAuditor(rules []AuditRule, logger *slog.Logger) (*FileAuditor, error) {
    watcher, err := fsnotify.NewWatcher()
    if err != nil {
        return nil, fmt.Errorf("creating fsnotify watcher: %w", err)
    }

    a := &FileAuditor{
        watcher:     watcher,
        logger:      logger,
        rules:       rules,
        eventCh:     make(chan AuditEvent, 4096),
        watchedDirs: make(map[string]bool),
    }

    for _, rule := range rules {
        if err := a.addWatch(rule); err != nil {
            watcher.Close()
            return nil, fmt.Errorf("adding watch for %s: %w", rule.Path, err)
        }
    }

    return a, nil
}

func (a *FileAuditor) addWatch(rule AuditRule) error {
    if err := a.watcher.Add(rule.Path); err != nil {
        return err
    }
    a.mu.Lock()
    a.watchedDirs[rule.Path] = true
    a.mu.Unlock()

    if !rule.Recurse {
        return nil
    }

    return filepath.WalkDir(rule.Path, func(path string, d os.DirEntry, err error) error {
        if err != nil {
            return nil // Skip inaccessible paths
        }
        if !d.IsDir() {
            return nil
        }
        for _, excl := range rule.Exclude {
            if strings.HasPrefix(path, excl) {
                return filepath.SkipDir
            }
        }
        if err := a.watcher.Add(path); err != nil {
            a.logger.Warn("failed to watch directory",
                "path", path,
                "error", err,
            )
        } else {
            a.mu.Lock()
            a.watchedDirs[path] = true
            a.mu.Unlock()
        }
        return nil
    })
}

func (a *FileAuditor) Run(ctx context.Context) error {
    hostname, _ := os.Hostname()

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()

        case event, ok := <-a.watcher.Events:
            if !ok {
                return nil
            }

            op := classifyOperation(event.Op)
            if op == "" {
                continue
            }

            ae := AuditEvent{
                Time:      time.Now().UTC(),
                Operation: op,
                Path:      event.Name,
                Hostname:  hostname,
            }

            // Handle new directories for recursive watches
            if event.Has(fsnotify.Create) {
                info, err := os.Lstat(event.Name)
                if err == nil && info.IsDir() {
                    if err := a.watcher.Add(event.Name); err != nil {
                        a.logger.Warn("failed to watch new directory",
                            "path", event.Name,
                            "error", err,
                        )
                    }
                }
            }

            select {
            case a.eventCh <- ae:
            default:
                a.logger.Error("audit event channel full, dropping event",
                    "path", event.Name,
                    "operation", op,
                )
            }

        case err, ok := <-a.watcher.Errors:
            if !ok {
                return nil
            }
            a.logger.Error("watcher error", "error", err)
        }
    }
}

func (a *FileAuditor) Events() <-chan AuditEvent {
    return a.eventCh
}

func (a *FileAuditor) Close() error {
    return a.watcher.Close()
}

func (a *FileAuditor) WatchCount() int {
    a.mu.RLock()
    defer a.mu.RUnlock()
    return len(a.watchedDirs)
}

func classifyOperation(op fsnotify.Op) string {
    switch {
    case op.Has(fsnotify.Create):
        return "create"
    case op.Has(fsnotify.Write):
        return "write"
    case op.Has(fsnotify.Remove):
        return "delete"
    case op.Has(fsnotify.Rename):
        return "rename"
    case op.Has(fsnotify.Chmod):
        return "chmod"
    }
    return ""
}
```

### fanotify Permission Guard (CGo Integration)

```go
// +build linux

package fanotify

/*
#include <sys/fanotify.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>

int init_fanotify() {
    return fanotify_init(
        FAN_CLASS_CONTENT | FAN_CLOEXEC | FAN_NONBLOCK | FAN_UNLIMITED_QUEUE | FAN_UNLIMITED_MARKS,
        O_RDONLY | O_LARGEFILE | O_CLOEXEC | O_NOATIME
    );
}

int mark_filesystem(int fd, const char *path, uint64_t mask) {
    return fanotify_mark(fd, FAN_MARK_ADD | FAN_MARK_FILESYSTEM, mask, AT_FDCWD, path);
}

int mark_ignore(int fd, const char *path, uint64_t mask) {
    return fanotify_mark(fd, FAN_MARK_ADD | FAN_MARK_IGNORED_MASK | FAN_MARK_IGNORED_SURV_MODIFY,
                         mask, AT_FDCWD, path);
}

int send_response(int fan_fd, int event_fd, int allow) {
    struct fanotify_response resp = {
        .fd = event_fd,
        .response = allow ? FAN_ALLOW : FAN_DENY,
    };
    return write(fan_fd, &resp, sizeof(resp));
}

int resolve_fd_path(int fd, char *buf, size_t size) {
    char proc_path[32];
    snprintf(proc_path, sizeof(proc_path), "/proc/self/fd/%d", fd);
    ssize_t n = readlink(proc_path, buf, size - 1);
    if (n < 0) return -1;
    buf[n] = '\0';
    return n;
}
*/
import "C"

import (
    "context"
    "fmt"
    "syscall"
    "unsafe"
)

type PermissionDecision int

const (
    Allow PermissionDecision = iota
    Deny
)

type PermissionEvent struct {
    FD        int
    PID       int32
    Mask      uint64
    Path      string
    ResponeCh chan<- PermissionDecision
}

type PermissionGuard struct {
    fd       C.int
    eventCh  chan PermissionEvent
    policy   PolicyFunc
}

type PolicyFunc func(event PermissionEvent) PermissionDecision

func NewPermissionGuard(mountPoint string, policy PolicyFunc) (*PermissionGuard, error) {
    fd := C.init_fanotify()
    if fd == -1 {
        return nil, fmt.Errorf("fanotify_init failed: %w", syscall.Errno(C.int(C.__errno_location())))
    }

    mask := C.uint64_t(C.FAN_OPEN_PERM | C.FAN_ACCESS_PERM)
    cPath := C.CString(mountPoint)
    defer C.free(unsafe.Pointer(cPath))

    if ret := C.mark_filesystem(fd, cPath, mask); ret == -1 {
        C.close(fd)
        return nil, fmt.Errorf("fanotify_mark failed: %w", syscall.EPERM)
    }

    // Ignore kernel and procfs events
    for _, ignorePath := range []string{"/proc", "/sys", "/dev"} {
        cp := C.CString(ignorePath)
        C.mark_ignore(fd, cp, mask)
        C.free(unsafe.Pointer(cp))
    }

    return &PermissionGuard{
        fd:      fd,
        eventCh: make(chan PermissionEvent, 1024),
        policy:  policy,
    }, nil
}

func (g *PermissionGuard) Run(ctx context.Context) error {
    defer C.close(g.fd)

    buf := make([]byte, 8192)
    bufPtr := unsafe.Pointer(&buf[0])

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        default:
        }

        n, err := C.read(g.fd, bufPtr, C.size_t(len(buf)))
        if n <= 0 {
            if err == syscall.EAGAIN {
                continue
            }
            return fmt.Errorf("fanotify read: %w", err)
        }

        // Parse events from buffer
        for off := 0; off < int(n); {
            meta := (*C.struct_fanotify_event_metadata)(unsafe.Pointer(&buf[off]))
            if meta.vers < C.FANOTIFY_METADATA_VERSION {
                break
            }

            if meta.fd >= 0 && (uint64(meta.mask)&uint64(C.FAN_OPEN_PERM|C.FAN_ACCESS_PERM)) != 0 {
                var pathBuf [4096]C.char
                C.resolve_fd_path(meta.fd, &pathBuf[0], 4096)
                path := C.GoString(&pathBuf[0])

                responseCh := make(chan PermissionDecision, 1)
                event := PermissionEvent{
                    FD:        int(meta.fd),
                    PID:       int32(meta.pid),
                    Mask:      uint64(meta.mask),
                    Path:      path,
                    ResponeCh: responseCh,
                }

                // Apply policy synchronously (permission events must be answered promptly)
                decision := g.policy(event)
                allow := C.int(0)
                if decision == Allow {
                    allow = 1
                }
                C.send_response(g.fd, meta.fd, allow)
                C.close(meta.fd)
            } else if meta.fd >= 0 {
                C.close(meta.fd)
            }

            off += int(meta.event_len)
        }
    }
}
```

## Container Use Cases

### Challenge: inotify Watches Are Per-Namespace

In Kubernetes, inotify watches are tied to the user namespace. Container-level tools that monitor file paths see paths relative to their mount namespace. A container watching `/data` is watching the container's overlay filesystem view of that path, not the host path.

```bash
# Check watches by container
for cid in $(crictl ps -q); do
    pid=$(crictl inspect --output go-template \
          --template '{{.info.pid}}' $cid 2>/dev/null)
    watches=$(cat /proc/$pid/fdinfo/* 2>/dev/null | grep -c "^wd:")
    name=$(crictl inspect --output go-template \
           --template '{{.status.metadata.name}}' $cid 2>/dev/null)
    echo "$watches $name ($cid)"
done | sort -rn | head -20
```

### Security Monitoring with fanotify in Kubernetes

fanotify with `FAN_MARK_FILESYSTEM` can monitor the overlay filesystem used by container layers:

```yaml
# DaemonSet for host-level fanotify security monitoring
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: fanotify-monitor
  namespace: security
spec:
  selector:
    matchLabels:
      app: fanotify-monitor
  template:
    metadata:
      labels:
        app: fanotify-monitor
    spec:
      hostPID: true    # Required to resolve PID to container
      hostNetwork: true
      volumes:
      - name: host-root
        hostPath:
          path: /
          type: Directory
      containers:
      - name: monitor
        image: <your-registry>/fanotify-monitor:latest
        securityContext:
          privileged: true    # Required for CAP_SYS_ADMIN
          runAsUser: 0
        volumeMounts:
        - name: host-root
          mountPath: /host
          readOnly: true
        resources:
          requests:
            cpu: "500m"
            memory: 256Mi
          limits:
            cpu: "2"
            memory: 512Mi
        env:
        - name: NODE_NAME
          valueFrom:
            fieldRef:
              fieldPath: spec.nodeName
```

### Resolving Container Identity from PID

When fanotify reports an event with a PID, you can resolve it to a container:

```go
package container

import (
    "fmt"
    "os"
    "path/filepath"
    "strings"
)

type ContainerInfo struct {
    PodName       string
    PodNamespace  string
    ContainerName string
    ContainerID   string
    NodeName      string
}

// ResolveContainer maps a host PID to its Kubernetes container context
func ResolveContainer(pid int32) (*ContainerInfo, error) {
    cgroupPath := fmt.Sprintf("/proc/%d/cgroup", pid)
    data, err := os.ReadFile(cgroupPath)
    if err != nil {
        return nil, fmt.Errorf("reading cgroup for pid %d: %w", pid, err)
    }

    for _, line := range strings.Split(string(data), "\n") {
        // cgroup v2: single line with container ID
        // Format: 0::/kubepods/besteffort/pod<podID>/<containerID>
        if strings.Contains(line, "kubepods") {
            parts := strings.Split(line, "/")
            for i, part := range parts {
                if part == "pod" + strings.TrimPrefix(parts[i], "pod") {
                    // Extract pod ID and container ID
                    info := &ContainerInfo{
                        ContainerID: filepath.Base(line),
                    }
                    // Resolve further via kubelet API or CRI
                    return info, nil
                }
            }
        }
    }
    return nil, fmt.Errorf("pid %d not in a kubernetes container", pid)
}

// GetContainerMountPath returns the overlay mount path for a container
func GetContainerMountPath(containerID string) (string, error) {
    // Parse /proc/mounts for the overlay mount of this container
    mounts, err := os.ReadFile("/proc/mounts")
    if err != nil {
        return "", err
    }

    for _, line := range strings.Split(string(mounts), "\n") {
        if strings.Contains(line, containerID) && strings.HasPrefix(line, "overlay") {
            fields := strings.Fields(line)
            if len(fields) >= 2 {
                return fields[1], nil
            }
        }
    }
    return "", fmt.Errorf("mount path not found for container %s", containerID)
}
```

### File Integrity Monitoring (FIM) for Compliance

```go
package fim

import (
    "context"
    "crypto/sha256"
    "encoding/hex"
    "fmt"
    "io"
    "log/slog"
    "os"
    "sync"
    "time"

    "github.com/fsnotify/fsnotify"
)

type FileBaseline map[string]FileRecord

type FileRecord struct {
    Path     string
    SHA256   string
    Size     int64
    Mode     os.FileMode
    ModTime  time.Time
    Baseline time.Time
}

type IntegrityViolation struct {
    Path      string
    Expected  FileRecord
    Actual    FileRecord
    ViolType  string  // "modified", "deleted", "permission_change"
    Timestamp time.Time
}

type FIMMonitor struct {
    baseline  FileBaseline
    mu        sync.RWMutex
    watcher   *fsnotify.Watcher
    logger    *slog.Logger
    violCh    chan IntegrityViolation
}

func NewFIMMonitor(paths []string, logger *slog.Logger) (*FIMMonitor, error) {
    watcher, err := fsnotify.NewWatcher()
    if err != nil {
        return nil, err
    }

    m := &FIMMonitor{
        baseline: make(FileBaseline),
        watcher:  watcher,
        logger:   logger,
        violCh:   make(chan IntegrityViolation, 256),
    }

    // Establish baseline
    for _, path := range paths {
        if err := m.baselinePath(path); err != nil {
            logger.Warn("failed to baseline path", "path", path, "error", err)
        }
        watcher.Add(path)
    }

    return m, nil
}

func (m *FIMMonitor) baselinePath(path string) error {
    info, err := os.Stat(path)
    if err != nil {
        return err
    }

    hash, err := hashFile(path)
    if err != nil {
        return err
    }

    record := FileRecord{
        Path:     path,
        SHA256:   hash,
        Size:     info.Size(),
        Mode:     info.Mode(),
        ModTime:  info.ModTime(),
        Baseline: time.Now(),
    }

    m.mu.Lock()
    m.baseline[path] = record
    m.mu.Unlock()
    return nil
}

func (m *FIMMonitor) Run(ctx context.Context) {
    for {
        select {
        case <-ctx.Done():
            return
        case event := <-m.watcher.Events:
            m.checkIntegrity(event)
        }
    }
}

func (m *FIMMonitor) checkIntegrity(event fsnotify.Event) {
    m.mu.RLock()
    baseline, exists := m.baseline[event.Name]
    m.mu.RUnlock()

    if !exists {
        return
    }

    if event.Has(fsnotify.Remove) {
        m.violCh <- IntegrityViolation{
            Path:      event.Name,
            Expected:  baseline,
            ViolType:  "deleted",
            Timestamp: time.Now(),
        }
        return
    }

    info, err := os.Stat(event.Name)
    if err != nil {
        return
    }

    if info.Mode() != baseline.Mode {
        m.violCh <- IntegrityViolation{
            Path:      event.Name,
            Expected:  baseline,
            Actual:    FileRecord{Mode: info.Mode()},
            ViolType:  "permission_change",
            Timestamp: time.Now(),
        }
    }

    if event.Has(fsnotify.Write) || event.Has(fsnotify.Create) {
        hash, err := hashFile(event.Name)
        if err != nil {
            return
        }
        if hash != baseline.SHA256 {
            m.violCh <- IntegrityViolation{
                Path:      event.Name,
                Expected:  baseline,
                Actual:    FileRecord{SHA256: hash, Size: info.Size()},
                ViolType:  "modified",
                Timestamp: time.Now(),
            }
        }
    }
}

func (m *FIMMonitor) Violations() <-chan IntegrityViolation {
    return m.violCh
}

func hashFile(path string) (string, error) {
    f, err := os.Open(path)
    if err != nil {
        return "", err
    }
    defer f.Close()

    h := sha256.New()
    if _, err := io.Copy(h, f); err != nil {
        return "", err
    }
    return hex.EncodeToString(h.Sum(nil)), nil
}
```

## Performance Characteristics and Benchmarks

### inotify Event Processing Rate

```bash
# Measure inotify event throughput
# Create a test harness that generates known file operations
cat <<'EOF' > /tmp/bench_inotify.sh
#!/usr/bin/env bash
TMPDIR=$(mktemp -d)
COUNT=10000

# Start inotify listener
inotifywait -m -r -e create,delete "$TMPDIR" > /dev/null 2>&1 &
LISTENER_PID=$!

START=$(date +%s%N)
for i in $(seq 1 $COUNT); do
    touch "$TMPDIR/file_$i"
done
END=$(date +%s%N)

kill $LISTENER_PID 2>/dev/null
rm -rf "$TMPDIR"

ELAPSED_NS=$((END - START))
ELAPSED_MS=$((ELAPSED_NS / 1000000))
OPS_PER_SEC=$((COUNT * 1000 / ELAPSED_MS))
echo "inotify: $COUNT creates in ${ELAPSED_MS}ms = ${OPS_PER_SEC} ops/sec"
EOF
bash /tmp/bench_inotify.sh
```

Typical results:
- inotify event delivery: ~100,000-200,000 events/second on modern hardware
- Queue overflow starts occurring at sustained rates above `max_queued_events` (default: 16384 events)
- fanotify permission events add ~5-15 microseconds of latency per file operation (the permission round-trip)

### Monitoring inotify Queue Overflow

```bash
# Check for dropped events across all inotify instances
grep -r "^" /proc/*/fdinfo/* 2>/dev/null | grep "inotify" | \
  awk -F: '{print $1}' | sort -u | while read fdinfo; do
    overflow=$(grep "^overflow" "$fdinfo" 2>/dev/null | awk '{print $2}')
    if [ -n "$overflow" ] && [ "$overflow" -gt "0" ]; then
        pid=$(echo "$fdinfo" | cut -d/ -f3)
        cmd=$(cat /proc/$pid/comm 2>/dev/null)
        echo "PID $pid ($cmd): $overflow overflows"
    fi
done
```

## Summary

The inotify/fanotify stack provides a powerful but nuanced foundation for file system monitoring in Linux:

- inotify is appropriate for application-level monitoring (config reload, build tools, log rotation triggers) where notification-only events are sufficient and the watched path set is bounded
- fanotify is required for security enforcement, filesystem-wide monitoring, and container security platforms where permission events and PID attribution are necessary
- The 8192 default watch limit on inotify is dangerously low for Kubernetes nodes running many containers; raise it to 524288 via sysctl for production nodes
- fanotify with `FAN_UNLIMITED_QUEUE | FAN_UNLIMITED_MARKS` plus `CAP_SYS_ADMIN` removes queue and mark limits but requires careful policy design to avoid system-wide hangs when the permission decision process crashes
- For container security monitoring, combine fanotify filesystem-wide marks with PID-to-container resolution via cgroup paths to provide per-pod attribution for compliance audit trails
