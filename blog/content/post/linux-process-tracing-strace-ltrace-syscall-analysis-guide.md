---
title: "Linux Process Tracing with strace and ltrace: Syscall Filtering, Timing, Process Trees, and Performance"
date: 2032-01-29T00:00:00-05:00
draft: false
tags: ["Linux", "strace", "ltrace", "Debugging", "System Calls", "Performance", "Tracing"]
categories:
- Linux
- Debugging
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Linux process tracing with strace and ltrace. Covers syscall filtering, timing and statistics options, process tree tracing, signal handling, file descriptor tracking, and performance overhead analysis for production debugging scenarios."
more_link: "yes"
url: "/linux-process-tracing-strace-ltrace-syscall-analysis-guide/"
---

`strace` and `ltrace` are the most direct tools for understanding what a Linux process is actually doing at the system call and library call level. When application logs fail to explain a hang, a permission error, or mysterious I/O behavior, these tools provide ground truth. This guide covers filtering, timing, process trees, and minimizing overhead for production use.

<!--more-->

# Linux Process Tracing: strace and ltrace in Production

## How strace Works

`strace` uses the `ptrace(2)` system call to intercept and record system calls made by a process. The kernel stops the traced process twice per syscall: on entry (to record arguments) and on exit (to record return value and error).

This interception mechanism has a significant performance cost: each intercepted syscall requires two context switches between the traced process and strace. On a process making millions of syscalls per second, this can slow execution by 10-100x.

For production tracing, use `-e trace=` filters aggressively, and prefer `perf trace` or eBPF (`bpftrace`) when overhead matters.

## Basic strace Usage

```bash
# Trace a new process
strace ls /tmp

# Attach to existing PID
strace -p 12345

# Follow forked processes
strace -f /usr/bin/nginx -g 'daemon off;'

# Save output to file
strace -o /tmp/strace-nginx.log -p $(pidof nginx)

# Show timing information
strace -t    # timestamp each line (wall clock)
strace -T    # show time spent in each syscall
strace -tt   # microsecond timestamps
strace -ttt  # Unix timestamp with microseconds
```

## Syscall Filtering

Filtering is essential for usable output. An unfiltered trace of a busy application produces megabytes of output per second.

### Filter by Syscall Category

```bash
# File I/O syscalls only
strace -e trace=file ls /tmp
# openat, stat, lstat, access, readlink, statfs, ...

# Network syscalls
strace -e trace=network curl -s https://example.com
# socket, connect, sendto, recvfrom, getsockopt, setsockopt, ...

# Memory management
strace -e trace=memory python3 -c "x = bytearray(100*1024*1024)"
# mmap, mprotect, munmap, brk, mremap, ...

# Process management
strace -e trace=process bash -c "for i in 1 2 3; do sleep 0.1; done"
# execve, fork, vfork, clone, wait4, exit_group, ...

# Signal handling
strace -e trace=signal kill -HUP 12345

# IPC
strace -e trace=ipc some-program

# Available categories:
# %file, %network, %memory, %process, %signal, %ipc, %desc, %stat, %statfs, %lstat
```

### Filter by Specific Syscall Names

```bash
# Only open/read/write/close
strace -e trace=openat,read,write,close cat /etc/hostname

# Network connection tracing
strace -e trace=connect,accept4,socket,bind,listen curl https://example.com

# Exclude specific syscalls (very useful for reducing noise)
strace -e trace='!futex,epoll_wait,nanosleep,select,poll' nginx

# Track file operations on specific paths
strace -e trace=openat -e path=/etc/passwd ./myapp

# Watch for failed syscalls only
strace -e trace='!all' -e signal='!all' -z ls /nonexistent
# (actually strace -z shows only calls that returned errors)
strace -z -e trace=openat,access ls /tmp
```

### strace -e Modifiers

```bash
# Show all calls EXCEPT the specified ones
strace -e trace='!futex,epoll_wait,getpid' ./server

# Combine with fault injection (inject errors into specific syscalls)
strace -e inject=openat:error=ENOENT ./myapp
# Every openat call will return ENOENT

# Inject error only on Nth occurrence
strace -e inject=write:error=ENOSPC:when=5 ./writer
# 5th write call returns ENOSPC

# Inject delay
strace -e inject=read:delay_exit=100ms ./reader
# Each read call is delayed by 100ms after completion

# Fault injection for testing resilience
strace -e inject=connect:error=ECONNREFUSED:when=3 ./client
```

## Timing and Statistics

### Syscall Statistics with -c

```bash
# Show syscall count and time summary (most useful for performance debugging)
strace -c ls -la /usr/lib

# Output:
# % time     seconds  usecs/call     calls    errors syscall
# ------ ----------- ----------- --------- --------- ----------------
#  35.23    0.000423          14        30           openat
#  22.15    0.000266          13        20           fstat
#  18.44    0.000221           7        30           mmap
#  12.01    0.000144          48         3           read
#   8.12    0.000097          97         1           execve
# ...
# ------ ----------- ----------- --------- --------- ----------------
# 100.00    0.001200                   200        15 total

# Sort by time consumed (default)
strace -c -S time ./myapp

# Sort by syscall count
strace -c -S calls ./myapp

# Combined: trace + statistics
strace -c -e trace=file,network ./myapp
```

### Per-Syscall Timing

```bash
# -T: show time spent in each syscall
strace -T -e trace=read,write,pread64,pwrite64 ./myapp 2>&1 | head -30
# read(4, "...", 65536) = 65536 <0.000123>
# write(1, "...", 65536) = 65536 <0.000089>

# Find slow syscalls: sort by time
strace -T -e trace=file 2>&1 ./myapp | \
  grep -oP '<\d+\.\d+>' | \
  tr -d '<>' | \
  sort -n | \
  tail -10

# Timestamp each line
strace -tt ./myapp 2>&1 | head -20
# 14:23:45.123456 execve("/usr/bin/myapp", ...) = 0
# 14:23:45.124001 openat(AT_FDCWD, "/etc/ld.so.preload", ...) = -1 ENOENT

# Compute time between syscalls (for detecting blocked periods)
strace -tt -e trace=read,write ./server 2>&1 | \
  awk '/^[0-9]/{t=$1; sub(/^[0-9:]+\./, "", t)} /read|write/{print t, $0}'
```

## Process Tree Tracing

### Following Forks

```bash
# -f: follow fork/vfork/clone
strace -f ./master-process

# With PID prefix (-ff writes separate files per PID)
strace -ff -o /tmp/trace ./nginx
ls /tmp/trace.*
# trace.12345  trace.12346  trace.12347 ...

# Read a specific PID's trace
cat /tmp/trace.12345 | grep execve

# -y: print paths associated with file descriptors
strace -yy -e trace=read,write -p 12345
# read(4</var/log/app.log>, ...) = 1024
# write(5<socket:[12345]>, ...) = 512

# -y + network shows socket details
strace -yy -e trace=sendto,recvfrom curl https://example.com
# sendto(5<TCP:[192.168.1.1:54321->93.184.216.34:443]>, ...) = 100
```

### Attaching to Process Trees

```bash
# Attach to all threads of a process
strace -p $(pidof java) $(pgrep -P $(pidof java) | xargs -I{} echo -p {})

# Function: strace all threads of a multi-threaded app
strace_all() {
    local main_pid=$1
    local args="-p $main_pid"
    for tid in $(ls /proc/$main_pid/task); do
        if [ "$tid" != "$main_pid" ]; then
            args="$args -p $tid"
        fi
    done
    strace -f $args "${@:2}"
}

strace_all $(pidof nginx) -e trace=file -T

# Follow child processes created after attach
strace -f -p 12345
# Automatically follows fork/clone/vfork
```

## File Descriptor Tracking

```bash
# Track all file operations with FD paths
strace -yy -e trace=openat,read,write,close,dup2,dup3 ./myapp

# Find which files a process has open
ls -la /proc/$(pidof myapp)/fd

# Watch for leaked file descriptors
strace -e trace=openat,close -p $(pidof myapp) 2>&1 | \
  awk '
  /openat/ && /= [0-9]/ {
    fd = gensub(/.*= ([0-9]+)$/, "\\1", "g")
    path = gensub(/.*openat\(.*?, "(.*?)".*/, "\\1", "g")
    fds[fd] = path
    print "OPEN fd=" fd " path=" path
  }
  /close\([0-9]+\)/ {
    fd = gensub(/close\(([0-9]+)\).*/, "\\1", "g")
    if (fd in fds) {
      print "CLOSE fd=" fd " path=" fds[fd]
      delete fds[fd]
    }
  }
  END {
    print "\n--- POSSIBLY LEAKED ---"
    for (fd in fds) print "fd=" fd " path=" fds[fd]
  }
  '
```

## Signal Tracing

```bash
# Track signals received and sent
strace -e signal=all ./myapp

# Only specific signals
strace -e signal=SIGSEGV,SIGBUS,SIGABRT ./myapp

# Show signal masks
strace -e trace=rt_sigprocmask,rt_sigaction ./myapp

# Debug signal handling in daemon
strace -p $(pidof nginx) -e signal=all,trace=kill,rt_sigqueueinfo

# Trace the SIGHUP reload cycle
strace -ff -e trace=signal,read,write -p $(pidof nginx) &
kill -HUP $(pidof nginx)
# Observe: read config files, worker graceful shutdown, new workers spawn
```

## Network Debugging

```bash
# Full TCP connection lifecycle
strace -yy -e trace=socket,bind,connect,accept4,sendto,recvfrom,shutdown,close \
    curl -s https://example.com

# DNS resolution (watch for blocking lookups)
strace -e trace=connect,sendto,recvfrom -e network \
    -T host example.com 2>&1 | \
    grep -E "(connect|recvfrom).*<[0-9]"

# Socket options being set
strace -e trace=setsockopt,getsockopt ./server

# Non-blocking I/O patterns
strace -e trace=epoll_create1,epoll_ctl,epoll_wait,read,write,accept4 \
    -T ./event-server 2>&1 | head -50

# Check for excessive poll/select loops
strace -c -e trace=poll,select,epoll_wait ./server
# High call count with very short times = busy-wait
```

## Memory Debugging

```bash
# Track mmap/munmap for memory leak investigation
strace -e trace=mmap,munmap,mprotect,brk -T ./myapp 2>&1 | \
  grep "mmap\|munmap" | \
  awk '
  /mmap/ && /= 0x/ {
    addr = gensub(/.*= (0x[0-9a-f]+)$/, "\\1", "g")
    size = gensub(/mmap\(.*?, ([0-9]+),.*/, "\\1", "g")
    mappings[addr] = size
    total += size
    printf "MMAP addr=%s size=%d total=%d\n", addr, size, total
  }
  /munmap\(0x/ {
    addr = gensub(/munmap\((0x[0-9a-f]+).*/, "\\1", "g")
    if (addr in mappings) {
      total -= mappings[addr]
      printf "MUNMAP addr=%s freed=%d total=%d\n", addr, mappings[addr], total
      delete mappings[addr]
    }
  }
  '

# Track huge page usage
strace -e trace=madvise ./myapp 2>&1 | \
  grep "MADV_HUGEPAGE\|MADV_NOHUGEPAGE"

# Find excessive brk calls (malloc fragmentation)
strace -c -e trace=brk,mmap ./myapp
```

## ltrace: Library Call Tracing

`ltrace` intercepts calls to shared library functions. It's useful when you need to understand higher-level behavior (string operations, regex, protocol parsing) without going to the syscall level.

### Basic ltrace Usage

```bash
# Trace library calls
ltrace ls /tmp

# Attach to running process
ltrace -p 12345

# Filter specific library functions
ltrace -e malloc,free,realloc ./myapp
# +++ exited (status 0) +++
# malloc(1024)                                    = 0x55a1234
# malloc(512)                                     = 0x55a2345
# free(0x55a1234)

# Suppress output from specific functions
ltrace -e '!strcmp,memcpy,strlen' ./myapp

# Show parameters with types
ltrace -A 64 ./myapp  # max string width: 64 chars

# Follow child processes
ltrace -f ./master
```

### C Library Debugging

```bash
# Find file path operations
ltrace -e fopen,fclose,fread,fwrite,fgets,fputs ./myapp

# String operations causing crashes
ltrace -e strcpy,strncpy,strcat,strncat,sprintf,snprintf ./myapp 2>&1 | \
  grep "segfault\|SIGSEGV\|abort"

# OpenSSL debugging
ltrace -l libssl.so -e SSL_connect,SSL_read,SSL_write,SSL_get_error ./client

# DNS resolution (libresolv)
ltrace -l libresolv.so -e res_query,res_search,getaddrinfo ./myapp
```

### ltrace with Statistics

```bash
# Call count summary
ltrace -c ./myapp

# Output:
# % time     seconds  usecs/call     calls      function
# ------ ----------- ----------- --------- --------------------
#  45.12    0.001234          82        15 malloc
#  22.34    0.000612          20        30 free
#  18.91    0.000518         172         3 fopen
#  ...

# Combined with strace for full picture
# (run in separate terminals)
strace -c ./myapp &
ltrace -c ./myapp
```

## Performance Overhead Analysis

### Measuring strace Impact

```bash
# Baseline without strace
time find /usr/lib -name "*.so" > /dev/null
# real 0m0.421s

# With strace (all syscalls)
time strace -o /dev/null find /usr/lib -name "*.so" > /dev/null
# real 0m12.847s (30x slower!)

# With strace (filtered to file syscalls)
time strace -e trace=file -o /dev/null find /usr/lib -name "*.so" > /dev/null
# real 0m4.231s (10x slower)

# With strace (statistics only, minimal output)
time strace -c find /usr/lib -name "*.so" > /dev/null
# real 0m2.112s (5x slower)

# Alternative: perf trace (much lower overhead)
time perf trace -e 'openat,read' find /usr/lib -name "*.so" > /dev/null
# real 0m0.689s (1.6x slower - uses perf_event_open, not ptrace)
```

### perf trace as Low-Overhead Alternative

```bash
# perf trace uses perf_event_open (ring buffer) instead of ptrace
# Much lower overhead for high-frequency syscalls

# Trace a running process
perf trace -p 12345

# Filter syscalls
perf trace -e openat,read,write -p 12345

# Summarize syscall statistics (like strace -c but much faster)
perf trace -s -p 12345 sleep 5

# System-wide trace for a duration
perf trace -a --duration 10 -e 'openat,connect'

# Trace with errno filtering (show only errors)
perf trace -e openat --failure -p 12345
```

### bpftrace as Production Alternative

```bash
# Count syscalls by process (zero overhead for uncalled syscalls)
bpftrace -e '
tracepoint:raw_syscalls:sys_enter
/pid == 12345/
{
  @syscalls[ksym(args->id)] = count();
}
interval:s:5 { print(@syscalls); clear(@syscalls); }
'

# Trace slow syscalls (only overhead when threshold exceeded)
bpftrace -e '
tracepoint:syscalls:sys_enter_openat
{
  @ts[tid] = nsecs;
  @fname[tid] = str(args->filename);
}
tracepoint:syscalls:sys_exit_openat
/@ts[tid]/
{
  $dur = (nsecs - @ts[tid]) / 1000;  // microseconds
  if ($dur > 1000) {  // > 1ms
    printf("SLOW openat: %s took %lld us (ret=%d)\n",
           @fname[tid], $dur, args->ret);
  }
  delete(@ts[tid]);
  delete(@fname[tid]);
}
'

# File descriptor leak detection
bpftrace -e '
tracepoint:syscalls:sys_exit_openat
/args->ret >= 0/
{
  @open_fds[pid, args->ret] = str(args->filename);  // Not quite right, but shows pattern
}
tracepoint:syscalls:sys_enter_close
{
  delete(@open_fds[pid, args->fd]);
}
'
```

## Practical Debugging Scenarios

### Scenario 1: Application Hangs on Startup

```bash
# Attach to hanging process and check what it's doing
strace -p $(pidof myapp) -T 2>&1 | head -5

# Likely culprits:
# 1. Waiting for file (file lock, named pipe, /dev/urandom entropy)
#    futex(0x..., FUTEX_WAIT, ...) = ?  [blocking]
#    open("/dev/random", ...) = 3
#    read(3, ...) = ?  [blocking for entropy]

# 2. DNS resolution timeout
#    connect(3, {AF_INET, "8.8.8.8", 53}, 16) = 0
#    sendto(3, ...) = 52
#    recvfrom(3, ...) = ?  [blocking for DNS reply]

# 3. Missing library
#    openat(AT_FDCWD, "/usr/lib/libfoo.so.1", O_RDONLY|O_CLOEXEC) = -1 ENOENT

# Solution: use -T to see how long the blocking call has been waiting
strace -T -p $(pidof myapp) 2>&1
```

### Scenario 2: Permission Errors

```bash
# Find all permission-denied errors
strace -z -e trace=file ./myapp 2>&1 | grep "EACCES\|EPERM\|ENOENT"

# Example output:
# openat(AT_FDCWD, "/etc/app/config.yaml", O_RDONLY) = -1 ENOENT (No such file or directory)
# openat(AT_FDCWD, "/var/run/app.pid", O_WRONLY|O_CREAT) = -1 EACCES (Permission denied)

# Check with -yy for FD paths
strace -yy -z -e trace=file,process ./myapp 2>&1 | \
  grep -E "EACCES|EPERM|ENOENT" | \
  grep -v "ld.so\|gconv\|locale"
```

### Scenario 3: High CPU in System Calls

```bash
# Which syscalls are consuming CPU?
strace -c -p $(pidof myapp) &
sleep 30
kill $!

# If futex dominates: mutex contention or condition variable spinning
# If epoll_wait dominates: normal for event-driven servers (not a problem)
# If getpid/gettid dominates: excessive syscall-per-request overhead
# If mmap/munmap dominates: memory allocator fragmentation
# If brk dominates: heap growth from leaks or working set increase

# For getpid/gettid: use vDSO versions (no syscall overhead)
# Modern glibc does this automatically; verify:
ltrace -e getpid ./myapp  # Should NOT appear if vDSO is working
```

### Scenario 4: Mysterious File Opens

```bash
# What configuration files does nginx actually read?
strace -e trace=openat -p $(pidof nginx | head -1) 2>&1 | \
  grep "O_RDONLY" | \
  awk '{print $2}' | \
  tr -d '",' | \
  sort -u

# What libraries are loaded at runtime by a plugin?
strace -f -e trace=openat ./app --load-plugin=myplugin 2>&1 | \
  grep ".so"
```

### Scenario 5: Network Connection Failures

```bash
# Detailed connection attempt trace with errno
strace -yy -T -e trace=socket,connect,sendto,recvfrom,read,write \
    -e signal='!all' \
    ./failing-client 2>&1

# Typical patterns:
# connect(3<TCP>, {AF_INET, "10.0.0.5", 8080}, ...) = -1 ECONNREFUSED
# connect(3<TCP>, {AF_INET, "10.0.0.5", 8080}, ...) = -1 ETIMEDOUT <30.012345>
# recvfrom(3<TCP:[...]>, ...) = 0  (EOF - connection closed by peer)

# Check for timeout values in setsockopt
strace -e trace=setsockopt ./client 2>&1 | grep "SO_RCVTIMEO\|SO_SNDTIMEO\|SO_TIMEOUT"
```

## Output Formatting

```bash
# String length limit (default 32, increase for full content)
strace -s 256 ./myapp

# Column-align output
strace -a 40 ./myapp

# Print unabbreviated structures
strace -v ./myapp

# Quiet: suppress attach/detach messages
strace -q -p 12345

# Decode numerical values to symbolic names
strace ./myapp  # fcntl flags, errno names, signal names: automatic

# Raw hex output (for binary protocols)
strace -x -e trace=read,write -p 12345

# Combine for maximum readability
strace -f -yy -T -s 512 -v -e trace=network,file ./myapp
```

## Summary

strace and ltrace are indispensable for black-box debugging of Linux processes. Key operational practices:

- Always use `-e trace=` filters in production — unfiltered strace on a busy process can cause severe performance degradation
- Use `-c` for statistics-only tracing when you want the call distribution without per-call output overhead
- Use `-T` to identify which specific syscall invocations are slow (disk reads, DNS, lock contention)
- Use `-ff -o /tmp/trace` when tracing multi-process applications; review each PID's trace separately
- Prefer `perf trace` or `bpftrace` for production systems where ptrace overhead is unacceptable
- The `-z` flag (show only failing calls) is extremely useful for debugging permission and file-not-found issues
- Combine `strace -yy` with file descriptor output to understand exactly which socket or file each read/write operates on
