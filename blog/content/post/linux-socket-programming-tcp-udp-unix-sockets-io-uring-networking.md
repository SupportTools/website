---
title: "Linux Socket Programming: TCP/UDP Advanced Options, UNIX Sockets, and io_uring for Networking"
date: 2030-03-20T00:00:00-05:00
draft: false
tags: ["Linux", "Socket Programming", "TCP", "io_uring", "UNIX Sockets", "Networking", "Performance"]
categories: ["Linux", "Systems Programming"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Advanced Linux socket programming: TCP_NODELAY, SO_REUSEPORT, TCP_CORK, UNIX domain sockets for IPC, abstract socket namespace, io_uring for async socket I/O, and zero-copy with MSG_ZEROCOPY."
more_link: "yes"
url: "/linux-socket-programming-tcp-udp-unix-sockets-io-uring-networking/"
---

Socket programming sits at the intersection of systems programming and network performance engineering. The socket API exposes decades of operating system development through a deceptively simple interface, but the performance difference between a naively configured socket and one using advanced options can be an order of magnitude. Modern Linux provides sophisticated mechanisms — io_uring for asynchronous I/O, MSG_ZEROCOPY for zero-copy data transmission, SO_REUSEPORT for multi-thread scaling — that enable building network applications competitive with purpose-built kernel bypass solutions.

This guide covers advanced socket options that directly impact production performance, UNIX domain sockets for high-performance IPC, the abstract socket namespace, and the paradigm shift that io_uring brings to asynchronous network programming in Go and C.

<!--more-->

## TCP Socket Options: Performance-Critical Configurations

The default TCP socket configuration is conservative and designed for compatibility, not performance. Production systems require careful tuning of socket options.

### TCP_NODELAY: Disabling the Nagle Algorithm

The Nagle algorithm coalesces small TCP packets to reduce network congestion. For low-latency applications (databases, RPC frameworks, game servers), this introduces unnecessary delay.

```c
// C: Enable TCP_NODELAY
int flag = 1;
setsockopt(sockfd, IPPROTO_TCP, TCP_NODELAY, &flag, sizeof(flag));
```

```go
// Go: TCP_NODELAY is enabled by default for TCP connections
// To explicitly set it:
import (
    "net"
    "syscall"
)

conn, err := net.Dial("tcp", "host:port")
if err != nil {
    return err
}

// Get the underlying TCP connection
tcpConn, ok := conn.(*net.TCPConn)
if !ok {
    return fmt.Errorf("not a TCP connection")
}

// TCP_NODELAY is enabled by default in Go's net package
// Disable it (enable Nagle) for batch/streaming scenarios
if err := tcpConn.SetNoDelay(false); err != nil {
    return fmt.Errorf("setting TCP_NODELAY: %w", err)
}
```

### TCP_CORK: Batching for Throughput

TCP_CORK does the opposite of TCP_NODELAY — it holds data until the buffer is full or TCP_CORK is disabled. Useful for file serving where you want to batch header + body:

```c
// C: Cork the socket to batch writes
int cork = 1;
setsockopt(sockfd, IPPROTO_TCP, TCP_CORK, &cork, sizeof(cork));

// Write HTTP headers
write(sockfd, http_headers, header_len);

// Write file contents
sendfile(sockfd, filefd, NULL, file_size);

// Uncork: flushes all buffered data in one TCP segment
cork = 0;
setsockopt(sockfd, IPPROTO_TCP, TCP_CORK, &cork, sizeof(cork));
```

```go
// Go: Access TCP_CORK via syscall (not exposed in net package)
import (
    "net"
    "syscall"
)

func setCork(conn *net.TCPConn, cork bool) error {
    rawConn, err := conn.SyscallConn()
    if err != nil {
        return err
    }

    var setErr error
    rawConn.Control(func(fd uintptr) {
        value := 0
        if cork {
            value = 1
        }
        setErr = syscall.SetsockoptInt(int(fd), syscall.IPPROTO_TCP, syscall.TCP_CORK, value)
    })
    return setErr
}
```

### SO_REUSEPORT: Multi-Thread Socket Scaling

SO_REUSEPORT allows multiple processes or threads to bind to the same port. The kernel load-balances incoming connections across all listening sockets, enabling near-linear scaling with CPU cores:

```c
// C: Enable SO_REUSEPORT
int reuse = 1;
setsockopt(sockfd, SOL_SOCKET, SO_REUSEPORT, &reuse, sizeof(reuse));
bind(sockfd, (struct sockaddr*)&addr, sizeof(addr));
listen(sockfd, SOMAXCONN);
```

```go
// Go: SO_REUSEPORT via ListenConfig
package main

import (
    "context"
    "net"
    "syscall"

    "golang.org/x/sys/unix"
)

func newReusePortListener(network, address string) (net.Listener, error) {
    lc := net.ListenConfig{
        Control: func(network, address string, conn syscall.RawConn) error {
            var setErr error
            conn.Control(func(fd uintptr) {
                setErr = syscall.SetsockoptInt(
                    int(fd),
                    syscall.SOL_SOCKET,
                    unix.SO_REUSEPORT,
                    1,
                )
            })
            return setErr
        },
    }
    return lc.Listen(context.Background(), network, address)
}

// Start multiple listeners on the same port (one per goroutine/CPU)
func startMultiCoreServer(address string, workers int) error {
    for i := 0; i < workers; i++ {
        listener, err := newReusePortListener("tcp", address)
        if err != nil {
            return fmt.Errorf("creating listener %d: %w", i, err)
        }

        go func(l net.Listener) {
            for {
                conn, err := l.Accept()
                if err != nil {
                    return
                }
                go handleConnection(conn)
            }
        }(listener)
    }
    return nil
}
```

### SO_KEEPALIVE and TCP Keepalive Tuning

TCP keepalives detect dead connections without application-level heartbeats:

```go
package main

import (
    "net"
    "syscall"
    "time"
)

func configureKeepalive(conn *net.TCPConn) error {
    // Enable keepalive
    if err := conn.SetKeepAlive(true); err != nil {
        return err
    }

    // Set keepalive period (time between keepalive probes when idle)
    if err := conn.SetKeepAlivePeriod(30 * time.Second); err != nil {
        return err
    }

    // For fine-grained control, use raw syscall
    rawConn, err := conn.SyscallConn()
    if err != nil {
        return err
    }

    rawConn.Control(func(fd uintptr) {
        // TCP_KEEPIDLE: seconds of idle before first keepalive probe (default: 7200)
        syscall.SetsockoptInt(int(fd), syscall.IPPROTO_TCP, syscall.TCP_KEEPIDLE, 30)

        // TCP_KEEPINTVL: seconds between keepalive probes (default: 75)
        syscall.SetsockoptInt(int(fd), syscall.IPPROTO_TCP, syscall.TCP_KEEPINTVL, 10)

        // TCP_KEEPCNT: number of failed probes before connection declared dead (default: 9)
        syscall.SetsockoptInt(int(fd), syscall.IPPROTO_TCP, syscall.TCP_KEEPCNT, 3)
    })

    return nil
}
```

### SO_RCVBUF and SO_SNDBUF: Buffer Sizing

For high-bandwidth applications, the default 128KB socket buffers are a bottleneck:

```go
func setSocketBuffers(conn *net.TCPConn, readBufSize, writeBufSize int) error {
    rawConn, err := conn.SyscallConn()
    if err != nil {
        return err
    }

    var setErr error
    rawConn.Control(func(fd uintptr) {
        // Note: kernel doubles the value you set (for internal overhead)
        // Setting 4MB gives effective 8MB buffer
        if readBufSize > 0 {
            setErr = syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET,
                syscall.SO_RCVBUF, readBufSize)
            if setErr != nil {
                return
            }
        }
        if writeBufSize > 0 {
            setErr = syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET,
                syscall.SO_SNDBUF, writeBufSize)
        }
    })
    return setErr
}

// System-wide buffer limits must be set high enough
// sysctl -w net.core.rmem_max=16777216
// setsockopt cannot exceed rmem_max without CAP_NET_ADMIN
```

### TCP_QUICKACK: Aggressive ACK Sending

```go
func setQuickACK(conn *net.TCPConn, enable bool) error {
    rawConn, err := conn.SyscallConn()
    if err != nil {
        return err
    }

    value := 0
    if enable {
        value = 1
    }

    rawConn.Control(func(fd uintptr) {
        syscall.SetsockoptInt(int(fd), syscall.IPPROTO_TCP,
            syscall.TCP_QUICKACK, value)
    })
    return nil
}
```

## UNIX Domain Sockets for High-Performance IPC

UNIX domain sockets provide the same socket API as TCP/UDP but communicate through the kernel without the overhead of the network stack. They are 5-10x faster than TCP loopback for same-host communication.

### UNIX Socket Types

```bash
# Three types of UNIX domain sockets:
# 1. SOCK_STREAM: reliable, ordered, connection-oriented (like TCP)
# 2. SOCK_DGRAM:  unreliable, message-oriented (like UDP), but on same host
# 3. SOCK_SEQPACKET: reliable, ordered, message-oriented

# Create a UNIX domain socket server
socat UNIX-LISTEN:/tmp/myapp.sock,fork EXEC:/bin/cat

# Connect and test
echo "hello" | socat - UNIX-CONNECT:/tmp/myapp.sock
```

### UNIX Socket Server in Go

```go
// unix_server.go
package main

import (
    "fmt"
    "net"
    "os"
)

func main() {
    sockPath := "/run/myapp/api.sock"

    // Clean up existing socket file
    os.Remove(sockPath)

    // Ensure directory exists
    if err := os.MkdirAll("/run/myapp", 0755); err != nil {
        panic(err)
    }

    listener, err := net.Listen("unix", sockPath)
    if err != nil {
        panic(fmt.Sprintf("failed to listen: %v", err))
    }
    defer listener.Close()
    defer os.Remove(sockPath)

    // Set permissions (only user and group can connect)
    if err := os.Chmod(sockPath, 0660); err != nil {
        panic(err)
    }

    fmt.Printf("Listening on %s\n", sockPath)

    for {
        conn, err := listener.Accept()
        if err != nil {
            fmt.Fprintf(os.Stderr, "Accept error: %v\n", err)
            continue
        }
        go handleUnixConn(conn)
    }
}

func handleUnixConn(conn net.Conn) {
    defer conn.Close()

    // Credentials: get UID/GID of connecting process
    unixConn, ok := conn.(*net.UnixConn)
    if ok {
        rawConn, _ := unixConn.SyscallConn()
        rawConn.Control(func(fd uintptr) {
            cred, err := syscall.GetsockoptUcred(int(fd),
                syscall.SOL_SOCKET, syscall.SO_PEERCRED)
            if err == nil {
                fmt.Printf("Connection from PID=%d UID=%d GID=%d\n",
                    cred.Pid, cred.Uid, cred.Gid)
            }
        })
    }

    // Handle the connection
    buf := make([]byte, 4096)
    n, err := conn.Read(buf)
    if err != nil {
        return
    }
    fmt.Printf("Received: %s\n", buf[:n])
    conn.Write([]byte("OK\n"))
}
```

### Abstract UNIX Socket Namespace

The abstract namespace is a Linux-specific extension that avoids creating socket files on the filesystem. The socket path starts with a null byte:

```go
// abstract_socket.go
package main

import (
    "net"
    "syscall"
)

// AbstractSocketPath prefix (null byte + name)
const abstractPath = "@myapp-control"  // @ represents null byte in many tools

func listenAbstract(name string) (net.Listener, error) {
    // Abstract socket path: null byte followed by name
    abstractAddr := "\x00" + name  // \x00 is the null byte prefix

    listener, err := net.Listen("unix", abstractAddr)
    if err != nil {
        return nil, fmt.Errorf("listening on abstract socket %s: %w", name, err)
    }
    return listener, nil
}

func dialAbstract(name string) (net.Conn, error) {
    abstractAddr := "\x00" + name
    conn, err := net.Dial("unix", abstractAddr)
    if err != nil {
        return nil, fmt.Errorf("connecting to abstract socket %s: %w", name, err)
    }
    return conn, nil
}

// Benefits of abstract sockets:
// 1. No filesystem cleanup required (socket disappears when closed)
// 2. No filesystem permission concerns
// 3. Cannot be accessed from other network namespaces (isolation)
// 4. Faster than filesystem sockets (no dentry/inode overhead)

// List active abstract sockets
// ss -xlp | grep '@'
// Or: cat /proc/net/unix | grep "^[0-9].*@"
```

### UNIX Socket with File Descriptor Passing

One of the most powerful UNIX socket features is passing open file descriptors between processes:

```go
// fd_passing.go
package main

import (
    "fmt"
    "net"
    "os"
    "syscall"
)

// SendFD sends a file descriptor over a UNIX socket
func SendFD(conn *net.UnixConn, fd int) error {
    rights := syscall.UnixRights(fd)
    _, _, err := conn.WriteMsgUnix(
        []byte("fd"),  // Control message must have at least 1 byte
        rights,
        nil,
    )
    return err
}

// ReceiveFD receives a file descriptor from a UNIX socket
func ReceiveFD(conn *net.UnixConn) (int, error) {
    buf := make([]byte, 128)
    oob := make([]byte, 128)

    n, oobn, _, _, err := conn.ReadMsgUnix(buf, oob)
    if err != nil {
        return -1, fmt.Errorf("reading msg: %w", err)
    }

    if n == 0 || oobn == 0 {
        return -1, fmt.Errorf("no data or control message received")
    }

    scms, err := syscall.ParseSocketControlMessage(oob[:oobn])
    if err != nil {
        return -1, fmt.Errorf("parsing control message: %w", err)
    }

    for _, scm := range scms {
        fds, err := syscall.ParseUnixRights(&scm)
        if err != nil {
            continue
        }
        if len(fds) > 0 {
            return fds[0], nil
        }
    }

    return -1, fmt.Errorf("no file descriptor in control message")
}

// Use case: privilege separation
// A privileged process opens a port < 1024 and passes the listening socket fd
// to an unprivileged worker process via UNIX socket.
// The worker can then accept connections without needing root privileges.

func privilegedSocketServer() {
    // Create control socket
    listener, _ := net.Listen("unix", "/run/myapp/fd-transfer.sock")
    defer listener.Close()

    conn, _ := listener.Accept()
    defer conn.Close()

    unixConn := conn.(*net.UnixConn)

    // Open privileged socket (port 80 requires root)
    httpListener, err := net.Listen("tcp", ":80")
    if err != nil {
        fmt.Fprintf(os.Stderr, "Cannot bind port 80: %v\n", err)
        return
    }

    // Get underlying file descriptor
    tcpListener := httpListener.(*net.TCPListener)
    f, _ := tcpListener.File()
    defer f.Close()

    // Send the fd to unprivileged worker
    if err := SendFD(unixConn, int(f.Fd())); err != nil {
        fmt.Fprintf(os.Stderr, "Failed to send fd: %v\n", err)
        return
    }

    fmt.Println("Sent privileged socket to worker process")
}
```

## io_uring: Asynchronous I/O for Networking

io_uring (added in Linux 5.1) is a revolutionary asynchronous I/O interface that submits multiple I/O operations to the kernel in a single syscall using shared ring buffers. For networking, io_uring enables:

- Batching multiple accept/recv/send operations in one syscall
- Zero-copy operation support
- Fixed buffers registered with the kernel for reduced overhead
- Multishot operations that repeat automatically

### io_uring Architecture

```
User Space                          Kernel Space

+------------------+                +------------------+
| Submission Queue |  --------->    | io_uring worker  |
| (SQ Ring)        |                | threads          |
| [SQE] [SQE] ...  |                |                  |
+------------------+                |   [accept]       |
                                    |   [recv]         |
+------------------+                |   [send]         |
| Completion Queue |  <---------    |   [close]        |
| (CQ Ring)        |                |                  |
| [CQE] [CQE] ...  |                +------------------+
+------------------+

No system calls needed for individual I/O operations!
Only io_uring_enter() to submit batch
```

### io_uring in C: Echo Server

```c
// io_uring echo server (simplified)
#include <liburing.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define QUEUE_DEPTH 256
#define BUFFER_SIZE 4096

enum request_type {
    ACCEPT,
    READ,
    WRITE,
};

struct request {
    enum request_type type;
    int client_fd;
    char buf[BUFFER_SIZE];
    int buf_len;
};

int main(void) {
    struct io_uring ring;
    struct io_uring_sqe *sqe;
    struct io_uring_cqe *cqe;

    // Initialize io_uring with QUEUE_DEPTH entries
    io_uring_queue_init(QUEUE_DEPTH, &ring, 0);

    // Create and bind server socket
    int server_fd = socket(AF_INET, SOCK_STREAM, 0);
    int opt = 1;
    setsockopt(server_fd, SOL_SOCKET, SO_REUSEPORT, &opt, sizeof(opt));

    struct sockaddr_in addr = {
        .sin_family = AF_INET,
        .sin_addr.s_addr = INADDR_ANY,
        .sin_port = htons(8080),
    };
    bind(server_fd, (struct sockaddr*)&addr, sizeof(addr));
    listen(server_fd, SOMAXCONN);

    // Submit initial accept request
    struct request *req = calloc(1, sizeof(*req));
    req->type = ACCEPT;

    sqe = io_uring_get_sqe(&ring);
    io_uring_prep_accept(sqe, server_fd, NULL, NULL, 0);
    io_uring_sqe_set_data(sqe, req);
    io_uring_submit(&ring);

    // Event loop
    while (1) {
        io_uring_wait_cqe(&ring, &cqe);
        req = io_uring_cqe_get_data(cqe);

        switch (req->type) {
        case ACCEPT: {
            int client_fd = cqe->res;
            if (client_fd >= 0) {
                // Submit read for the new client
                struct request *read_req = calloc(1, sizeof(*read_req));
                read_req->type = READ;
                read_req->client_fd = client_fd;

                sqe = io_uring_get_sqe(&ring);
                io_uring_prep_recv(sqe, client_fd, read_req->buf, BUFFER_SIZE, 0);
                io_uring_sqe_set_data(sqe, read_req);
            }
            // Re-submit accept for next connection
            sqe = io_uring_get_sqe(&ring);
            io_uring_prep_accept(sqe, server_fd, NULL, NULL, 0);
            io_uring_sqe_set_data(sqe, req);
            io_uring_submit(&ring);
            break;
        }

        case READ: {
            int bytes = cqe->res;
            if (bytes > 0) {
                req->buf_len = bytes;
                req->type = WRITE;

                sqe = io_uring_get_sqe(&ring);
                io_uring_prep_send(sqe, req->client_fd, req->buf, bytes, 0);
                io_uring_sqe_set_data(sqe, req);
                io_uring_submit(&ring);
            } else {
                // Client disconnected
                close(req->client_fd);
                free(req);
            }
            break;
        }

        case WRITE: {
            // Write complete, read next request
            req->type = READ;

            sqe = io_uring_get_sqe(&ring);
            io_uring_prep_recv(sqe, req->client_fd, req->buf, BUFFER_SIZE, 0);
            io_uring_sqe_set_data(sqe, req);
            io_uring_submit(&ring);
            break;
        }
        }

        io_uring_cqe_seen(&ring, cqe);
    }

    io_uring_queue_exit(&ring);
    return 0;
}
```

### io_uring in Go with giouring

```go
// io_uring echo server in Go using github.com/iceber/iouring-go
package main

import (
    "fmt"
    "net"
    "os"
    "syscall"

    iouring "github.com/iceber/iouring-go"
)

func main() {
    // Create io_uring instance with 256 entries
    iour, err := iouring.New(256)
    if err != nil {
        panic(fmt.Sprintf("creating io_uring: %v", err))
    }
    defer iour.Close()

    // Create server socket
    serverFd, err := syscall.Socket(syscall.AF_INET, syscall.SOCK_STREAM, 0)
    if err != nil {
        panic(err)
    }

    // Set socket options
    syscall.SetsockoptInt(serverFd, syscall.SOL_SOCKET, syscall.SO_REUSEPORT, 1)
    syscall.SetsockoptInt(serverFd, syscall.IPPROTO_TCP, syscall.TCP_NODELAY, 1)

    addr := syscall.SockaddrInet4{Port: 8080}
    copy(addr.Addr[:], net.ParseIP("0.0.0.0").To4())
    syscall.Bind(serverFd, &addr)
    syscall.Listen(serverFd, 128)

    fmt.Println("Listening on :8080 with io_uring")

    // Accept connections using io_uring
    resultCh := make(chan iouring.Result, 32)
    for {
        // Submit accept via io_uring
        req, err := iour.Accept(serverFd, resultCh)
        if err != nil {
            fmt.Fprintf(os.Stderr, "submitting accept: %v\n", err)
            continue
        }
        _ = req

        // Wait for completion
        result := <-resultCh
        if err := result.Err(); err != nil {
            fmt.Fprintf(os.Stderr, "accept error: %v\n", err)
            continue
        }

        clientFd := result.ReturnValue0().(int)
        go handleClientIoUring(iour, clientFd)
    }
}

func handleClientIoUring(iour *iouring.IOURing, fd int) {
    defer syscall.Close(fd)

    buf := make([]byte, 4096)
    resultCh := make(chan iouring.Result, 4)

    for {
        // Read using io_uring
        _, err := iour.Recv(fd, buf, 0, resultCh)
        if err != nil {
            return
        }

        result := <-resultCh
        if result.Err() != nil || result.ReturnValue0().(int) == 0 {
            return
        }

        n := result.ReturnValue0().(int)

        // Echo back using io_uring
        _, err = iour.Send(fd, buf[:n], 0, resultCh)
        if err != nil {
            return
        }

        <-resultCh
    }
}
```

## Zero-Copy Networking with MSG_ZEROCOPY

MSG_ZEROCOPY (Linux 4.14+) allows the kernel to use the user's buffer directly for DMA without copying:

```go
// zero_copy.go
package main

import (
    "fmt"
    "syscall"
    "unsafe"
)

// sendZeroCopy sends data from buf to fd with zero-copy
// Requires SO_ZEROCOPY socket option and handling of completion notifications
func sendZeroCopy(fd int, buf []byte) (int, error) {
    // First, enable SO_ZEROCOPY on the socket
    if err := syscall.SetsockoptInt(fd, syscall.SOL_SOCKET,
        syscall.SO_ZEROCOPY, 1); err != nil {
        return 0, fmt.Errorf("enabling SO_ZEROCOPY: %w", err)
    }

    // Send with MSG_ZEROCOPY flag
    n, _, errno := syscall.Syscall6(
        syscall.SYS_SENDMSG,
        uintptr(fd),
        uintptr(unsafe.Pointer(&syscall.Msghdr{
            Iov:    &syscall.Iovec{Base: &buf[0], Len: uint64(len(buf))},
            Iovlen: 1,
        })),
        syscall.MSG_ZEROCOPY,
        0, 0, 0,
    )
    if errno != 0 {
        return 0, fmt.Errorf("sendmsg with zerocopy: %w", errno)
    }

    // Must drain the completion notifications from the error queue
    // Kernel sends MSG_ERRQUEUE notifications when DMA is complete
    // and the buffer can be reused
    drainZeroCopyNotifications(fd)

    return int(n), nil
}

func drainZeroCopyNotifications(fd int) {
    buf := make([]byte, 32)
    oob := make([]byte, 1024)

    for {
        _, _, _, _, err := syscall.Recvmsg(fd, buf, oob,
            syscall.MSG_ERRQUEUE|syscall.MSG_DONTWAIT)
        if err != nil {
            break // No more notifications
        }
    }
}
```

### sendfile: Kernel-Space File-to-Socket Transfer

For file serving, sendfile transfers data directly between file and socket file descriptors in kernel space:

```go
// file_serving.go
package main

import (
    "net"
    "os"
    "syscall"
)

// ServeFile sends a file to a TCP connection using sendfile
// Avoids user-space buffer allocation entirely
func ServeFile(conn *net.TCPConn, path string) error {
    f, err := os.Open(path)
    if err != nil {
        return err
    }
    defer f.Close()

    info, err := f.Stat()
    if err != nil {
        return err
    }

    // Get the TCP connection's file descriptor
    tcpFile, err := conn.File()
    if err != nil {
        return err
    }
    defer tcpFile.Close()

    // TCP_CORK: hold output until sendfile completes (batch header + body)
    sockFd := int(tcpFile.Fd())
    syscall.SetsockoptInt(sockFd, syscall.IPPROTO_TCP, syscall.TCP_CORK, 1)

    // Write headers (goes into kernel buffer due to TCP_CORK)
    headers := "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n\r\n"
    syscall.Write(sockFd, []byte(headers))

    // sendfile: file contents go directly from page cache to socket
    var offset int64 = 0
    remaining := info.Size()
    for remaining > 0 {
        n, err := syscall.Sendfile(sockFd, int(f.Fd()), &offset, int(remaining))
        if err != nil {
            return err
        }
        remaining -= int64(n)
    }

    // Uncork: flush everything in one go
    syscall.SetsockoptInt(sockFd, syscall.IPPROTO_TCP, syscall.TCP_CORK, 0)
    return nil
}
```

## UDP Socket Advanced Configuration

For UDP-based protocols (QUIC, DNS, games, real-time media):

```go
// udp_advanced.go
package main

import (
    "net"
    "syscall"
)

func createHighPerformanceUDPSocket(port int) (*net.UDPConn, error) {
    conn, err := net.ListenUDP("udp4", &net.UDPAddr{Port: port})
    if err != nil {
        return nil, err
    }

    rawConn, err := conn.SyscallConn()
    if err != nil {
        conn.Close()
        return nil, err
    }

    rawConn.Control(func(fd uintptr) {
        // Enable SO_REUSEPORT for multi-thread UDP processing
        syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET,
            syscall.SO_REUSEPORT, 1)

        // Increase receive buffer (important for bursty UDP traffic)
        // 32MB receive buffer
        syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET,
            syscall.SO_RCVBUF, 32*1024*1024)

        // Increase send buffer
        syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET,
            syscall.SO_SNDBUF, 32*1024*1024)

        // Enable IP_PKTINFO to receive source address with each datagram
        syscall.SetsockoptInt(int(fd), syscall.IPPROTO_IP,
            syscall.IP_PKTINFO, 1)

        // Enable IP_RECVTOS to receive DSCP/ECN bits
        syscall.SetsockoptInt(int(fd), syscall.IPPROTO_IP,
            syscall.IP_RECVTOS, 1)
    })

    return conn, nil
}

// RecvmmsgBatch: receive multiple datagrams in one syscall
// Much more efficient than calling Recvfrom in a loop
func recvmmsgBatch(fd int, batchSize int) error {
    type mmsgHdr struct {
        Hdr syscall.Msghdr
        Len uint32
        _   [4]byte
    }

    bufs := make([][]byte, batchSize)
    msgs := make([]mmsgHdr, batchSize)

    for i := range bufs {
        bufs[i] = make([]byte, 65535)
        msgs[i].Hdr.Iov = &syscall.Iovec{
            Base: &bufs[i][0],
            Len:  65535,
        }
        msgs[i].Hdr.Iovlen = 1
    }

    // Single syscall to receive up to batchSize datagrams
    r1, _, errno := syscall.Syscall6(
        syscall.SYS_RECVMMSG,
        uintptr(fd),
        uintptr(unsafe.Pointer(&msgs[0])),
        uintptr(batchSize),
        0, 0, 0,
    )
    if errno != 0 {
        return fmt.Errorf("recvmmsg: %w", errno)
    }

    received := int(r1)
    for i := 0; i < received; i++ {
        n := msgs[i].Len
        processPacket(bufs[i][:n])
    }
    return nil
}
```

## Socket Performance Benchmarking

```bash
# Benchmark TCP loopback vs UNIX socket throughput
# Install: apt-get install netperf

# TCP loopback benchmark
netperf -H 127.0.0.1 -t TCP_STREAM -l 10 -- -m 65536
# MIGRATED TCP STREAM TEST from 0.0.0.0 to 127.0.0.1
# Recv   Send    Send
# Socket Socket  Message  Elapsed
# Size   Size    Size     Time     Throughput
# bytes  bytes   bytes    secs.    10^6bits/sec
# 131072 16384   65536    10.00    25432.67

# UNIX socket benchmark
netperf -H /tmp/netperf.sock -t UNIX_STREAM -l 10 -- -m 65536
# Throughput: ~40000-80000 Mbits/sec (significantly faster than TCP loopback)

# Measure latency with iperf3
iperf3 -s -p 5201 &
iperf3 -c 127.0.0.1 -p 5201 --zerocopy  # Test zero-copy path
iperf3 -c 127.0.0.1 -p 5201             # Normal path

# Compare
iperf3 -c 127.0.0.1 -p 5201 -t 30 -P 8 --zerocopy
# [SUM] 0.00-30.00 sec  93.0 GBytes  26.6 Gbits/sec  sender (with zerocopy)
# vs without zerocopy:
# [SUM] 0.00-30.00 sec  81.2 GBytes  23.2 Gbits/sec  sender
```

## Key Takeaways

Advanced Linux socket programming enables performance gains that application-level optimization cannot achieve:

**TCP_NODELAY is critical for interactive protocols**: Any RPC framework, database client, or interactive application should disable Nagle. Go enables it by default for TCP connections; verify this is not accidentally disabled.

**SO_REUSEPORT enables true multi-core scaling**: Traditional socket servers have a single accept queue shared by all threads (with thundering herd). SO_REUSEPORT gives each thread its own kernel-balanced accept queue, eliminating the contention.

**UNIX sockets are the right choice for same-host IPC**: When your application and a database, cache, or microservice are on the same host (including Kubernetes pods sharing a node), UNIX sockets provide 3-5x lower latency than TCP loopback. Abstract sockets eliminate the cleanup requirement.

**io_uring reduces syscall overhead for high-concurrency servers**: Traditional epoll-based servers make one syscall per I/O operation. io_uring batches hundreds of operations into a single enter syscall, dramatically reducing context-switch overhead at high connection counts.

**MSG_ZEROCOPY and sendfile eliminate buffer copies**: For high-throughput data transfer (file servers, proxies, streaming), eliminating the user-space buffer copy from the data path can reduce CPU utilization by 30-50% under load.

Combining SO_REUSEPORT for multi-core accept, io_uring for async I/O, and sendfile/MSG_ZEROCOPY for data transfer creates network servers that approach the performance of kernel-bypass technologies without requiring kernel modifications.
