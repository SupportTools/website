---
title: "Linux Systemd Socket Activation: Zero-Downtime Service Handoff and Lazy Start"
date: 2030-12-16T00:00:00-05:00
draft: false
tags: ["Linux", "Systemd", "Socket Activation", "Zero-Downtime", "Go", "gRPC", "DevOps", "Service Management"]
categories:
- Linux
- Systems Programming
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to systemd socket activation: socket unit configuration, SD_LISTEN_FDS protocol, HTTP and gRPC socket activation in Go, file descriptor passing for zero-downtime restarts, and containerized socket activation patterns for production services."
more_link: "yes"
url: "/linux-systemd-socket-activation-zero-downtime-service-handoff/"
---

Systemd socket activation separates the act of listening on a socket from the act of running a service. Systemd holds the socket open during service restarts, accepts connections into a kernel queue, then hands the file descriptor to the new service process — achieving truly zero-downtime restarts with no dropped connections. This guide covers the complete implementation from unit file configuration through production Go services.

<!--more-->

# Linux Systemd Socket Activation: Zero-Downtime Service Handoff and Lazy Start

## Section 1: How Socket Activation Works

Traditional service restarts have a gap:

```
Service v1 running → systemd stops v1 → socket closes → connections refused
→ systemd starts v2 → socket opens → connections accepted
```

With socket activation:

```
Systemd holds socket open (SD_LISTEN_FDS_START) ──────────────────────────┐
Service v1 running ──→ systemd stops v1 ──→ kernel queues connections    │
                                         ──→ systemd starts v2          │
                                         ──→ v2 inherits fd from systemd ┘
→ No connections dropped, no refused connections
```

The key insight: the kernel `listen()` backlog accumulates connections during the restart window. Systemd holds the file descriptor and passes it to the new process. The SD_LISTEN_FDS_START file descriptor (fd 3) is already in listening state when the process starts.

### Socket Activation Sequence

1. `myapp.socket` unit starts — systemd calls `socket()`, `bind()`, `listen()`
2. First connection arrives OR `myapp.service` is enabled — systemd starts `myapp.service`
3. Systemd sets `LISTEN_FDS=1`, `LISTEN_FDNAMES=myapp`, `LISTEN_PID=<service-pid>`
4. Service process reads `LISTEN_FDS` and uses fd 3 (`SD_LISTEN_FDS_START`)
5. On service restart: systemd holds fd 3, restarts service, new process gets same fd

## Section 2: Unit File Configuration

### Basic HTTP Socket Activation

```ini
# /etc/systemd/system/myapp.socket
[Unit]
Description=MyApp HTTP Socket
Documentation=https://docs.support.tools/myapp

[Socket]
# The address to listen on
ListenStream=0.0.0.0:8080
# Listen on IPv6 as well
ListenStream=[::]:8080

# Socket options
NoDelay=true
KeepAlive=true
KeepAliveTimeSec=60

# Socket receive and send buffer sizes
ReceiveBuffer=4194304   # 4MB
SendBuffer=4194304      # 4MB

# Maximum connection backlog
Backlog=4096

# Socket permissions (if using Unix domain sockets)
# SocketMode=0660
# SocketUser=myapp
# SocketGroup=www-data

# Accept model: false = one service handles all connections (default)
# true = spawn one service instance per connection (inetd style)
Accept=false

# Socket file descriptor name (accessible via sd_listen_fds_with_names)
FileDescriptorName=http

[Install]
WantedBy=sockets.target
```

```ini
# /etc/systemd/system/myapp.service
[Unit]
Description=MyApp HTTP Server
Documentation=https://docs.support.tools/myapp
# Require the socket to exist before starting
Requires=myapp.socket
# Start after the socket is ready
After=myapp.socket network.target

[Service]
Type=notify
User=myapp
Group=myapp

# Working directory
WorkingDirectory=/opt/myapp

# The binary and arguments
ExecStart=/opt/myapp/bin/myapp serve

# Reload without downtime (SIGUSR2 triggers fd handoff in Go)
ExecReload=/bin/kill -s USR2 $MAINPID

# Graceful shutdown timeout
TimeoutStopSec=30

# Restart policy
Restart=on-failure
RestartSec=5

# Resource limits
LimitNOFILE=65536
LimitNPROC=4096

# Security hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/myapp /var/log/myapp
CapabilityBoundingSet=

# Environment
Environment=GOMAXPROCS=4
EnvironmentFile=-/etc/myapp/env

# Watchdog — service must notify systemd within this interval
WatchdogSec=30

[Install]
WantedBy=multi-user.target
```

### Unix Domain Socket for gRPC

```ini
# /etc/systemd/system/myapp-grpc.socket
[Unit]
Description=MyApp gRPC Unix Socket
PartOf=myapp.service

[Socket]
# Unix domain socket for local gRPC
ListenStream=/run/myapp/grpc.sock
SocketMode=0660
SocketUser=myapp
SocketGroup=myapp
FileDescriptorName=grpc

# Permissions directory
DirectoryMode=0750

[Install]
WantedBy=sockets.target
```

### Multiple Sockets on One Service

```ini
# /etc/systemd/system/myapp-multi.socket
[Unit]
Description=MyApp Multi-Protocol Socket
PartOf=myapp.service

[Socket]
# HTTP
ListenStream=0.0.0.0:8080
FileDescriptorName=http

# HTTPS
ListenStream=0.0.0.0:8443
FileDescriptorName=https

# gRPC
ListenStream=0.0.0.0:9090
FileDescriptorName=grpc

# Admin (Unix socket, restricted)
ListenStream=/run/myapp/admin.sock
SocketMode=0600
SocketUser=myapp
FileDescriptorName=admin

[Install]
WantedBy=sockets.target
```

## Section 3: SD_LISTEN_FDS Protocol

The systemd socket activation protocol passes listening file descriptors through environment variables:

| Variable | Description |
|----------|-------------|
| `LISTEN_PID` | PID that should use the fds (must match `getpid()`) |
| `LISTEN_FDS` | Number of file descriptors passed |
| `LISTEN_FDNAMES` | Colon-separated list of fd names (optional) |

File descriptors start at `SD_LISTEN_FDS_START` = 3. With `LISTEN_FDS=3`, the descriptors are at fd 3, 4, and 5.

## Section 4: Go Implementation

### Using the go-systemd Library

```bash
go get github.com/coreos/go-systemd/v22/activation
go get github.com/coreos/go-systemd/v22/daemon
```

### HTTP Server with Socket Activation

```go
// cmd/server/main.go
package main

import (
    "context"
    "crypto/tls"
    "fmt"
    "log/slog"
    "net"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/coreos/go-systemd/v22/activation"
    "github.com/coreos/go-systemd/v22/daemon"
)

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

    // Attempt to get listeners from systemd socket activation
    listeners, err := activation.Listeners()
    if err != nil {
        logger.Error("failed to get systemd listeners", "error", err)
        os.Exit(1)
    }

    var httpListener net.Listener

    if len(listeners) > 0 {
        // Running under systemd socket activation
        logger.Info("using systemd socket activation",
            "count", len(listeners))
        httpListener = listeners[0]
    } else {
        // Not under systemd — bind normally (useful for development)
        addr := "0.0.0.0:8080"
        httpListener, err = net.Listen("tcp", addr)
        if err != nil {
            logger.Error("failed to bind socket", "addr", addr, "error", err)
            os.Exit(1)
        }
        logger.Info("listening on address", "addr", addr)
    }

    // Build HTTP server
    mux := http.NewServeMux()
    mux.HandleFunc("/", handleRoot)
    mux.HandleFunc("/health", handleHealth)
    mux.HandleFunc("/ready", handleReady)

    srv := &http.Server{
        Handler:           mux,
        ReadTimeout:       30 * time.Second,
        ReadHeaderTimeout: 10 * time.Second,
        WriteTimeout:      30 * time.Second,
        IdleTimeout:       120 * time.Second,
        ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelError),
    }

    // Notify systemd that we are ready (Type=notify in service unit)
    sent, err := daemon.SdNotify(false, daemon.SdNotifyReady)
    if err != nil {
        logger.Warn("failed to notify systemd", "error", err)
    }
    if sent {
        logger.Info("notified systemd: READY=1")
    }

    // Start watchdog goroutine
    watchdogInterval, err := daemon.SdWatchdogEnabled(false)
    if err == nil && watchdogInterval > 0 {
        go func() {
            ticker := time.NewTicker(watchdogInterval / 2)
            defer ticker.Stop()
            for range ticker.C {
                daemon.SdNotify(false, daemon.SdNotifyWatchdog)
            }
        }()
        logger.Info("watchdog enabled", "interval", watchdogInterval)
    }

    // Handle signals
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM, syscall.SIGUSR2)

    // Start serving
    errCh := make(chan error, 1)
    go func() {
        logger.Info("starting HTTP server")
        if err := srv.Serve(httpListener); err != nil && err != http.ErrServerClosed {
            errCh <- fmt.Errorf("HTTP server error: %w", err)
        }
    }()

    // Wait for signal or error
    select {
    case sig := <-sigCh:
        logger.Info("received signal", "signal", sig)

        // Notify systemd we are stopping
        daemon.SdNotify(false, daemon.SdNotifyStopping)

        // Graceful shutdown
        ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
        defer cancel()

        logger.Info("initiating graceful shutdown")
        if err := srv.Shutdown(ctx); err != nil {
            logger.Error("shutdown error", "error", err)
        }

    case err := <-errCh:
        logger.Error("server error", "error", err)
        os.Exit(1)
    }

    logger.Info("server stopped")
}

func handleRoot(w http.ResponseWriter, r *http.Request) {
    fmt.Fprintf(w, "Hello from socket-activated service!\n")
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusOK)
    fmt.Fprintf(w, `{"status":"healthy"}`)
}

func handleReady(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusOK)
    fmt.Fprintf(w, `{"status":"ready"}`)
}
```

### Multiple Socket Types in One Service

```go
// cmd/server/server.go — handling HTTP + gRPC + Unix admin socket
package main

import (
    "context"
    "fmt"
    "net"
    "net/http"
    "os"

    "github.com/coreos/go-systemd/v22/activation"
    "google.golang.org/grpc"
)

type Server struct {
    httpSrv  *http.Server
    grpcSrv  *grpc.Server
    adminSrv *http.Server
}

func NewServerFromSystemd() (*Server, error) {
    // Get named listeners from systemd
    listeners, err := activation.ListenersWithNames()
    if err != nil {
        return nil, fmt.Errorf("getting systemd listeners: %w", err)
    }

    s := &Server{}

    // Match listeners by name (from FileDescriptorName in .socket unit)
    for name, fds := range listeners {
        if len(fds) == 0 {
            continue
        }
        switch name {
        case "http":
            s.httpSrv = &http.Server{
                Handler: buildHTTPRouter(),
            }
            go s.httpSrv.Serve(fds[0])

        case "grpc":
            s.grpcSrv = grpc.NewServer(
                grpc.UnaryInterceptor(loggingInterceptor),
            )
            registerGRPCServices(s.grpcSrv)
            go s.grpcSrv.Serve(fds[0])

        case "admin":
            s.adminSrv = &http.Server{
                Handler: buildAdminRouter(),
            }
            go s.adminSrv.Serve(fds[0])
        }
    }

    return s, nil
}

func (s *Server) Shutdown(ctx context.Context) error {
    errs := make(chan error, 3)

    if s.httpSrv != nil {
        go func() { errs <- s.httpSrv.Shutdown(ctx) }()
    }
    if s.grpcSrv != nil {
        go func() {
            s.grpcSrv.GracefulStop()
            errs <- nil
        }()
    }
    if s.adminSrv != nil {
        go func() { errs <- s.adminSrv.Shutdown(ctx) }()
    }

    var lastErr error
    for i := 0; i < 3; i++ {
        if err := <-errs; err != nil {
            lastErr = err
        }
    }
    return lastErr
}
```

## Section 5: Zero-Downtime Restarts via FD Passing

The purest form of zero-downtime restart passes the file descriptor from the old process to the new process during an in-place upgrade. This is how nginx, HAProxy, and caddy achieve it.

### Fork-Exec Model with FD Inheritance

```go
// pkg/graceful/restart.go
package graceful

import (
    "encoding/json"
    "fmt"
    "net"
    "os"
    "os/exec"
    "syscall"
)

const (
    // Environment variable signaling the process was restarted
    envRestart      = "APP_RESTARTED"
    envListenerFDs  = "APP_LISTENER_FDS"
)

// ListenerInfo describes a listener to pass to the child process.
type ListenerInfo struct {
    Addr    string `json:"addr"`
    Network string `json:"network"`
    FD      uintptr `json:"fd"`
}

// Manager handles zero-downtime restarts.
type Manager struct {
    listeners []*net.TCPListener
}

// NewManager creates a restart manager with the given listeners.
func NewManager(listeners ...*net.TCPListener) *Manager {
    return &Manager{listeners: listeners}
}

// Restart forks a new process that inherits the listening sockets,
// then signals the parent to shut down gracefully.
func (m *Manager) Restart() error {
    var files []*os.File
    var infos []ListenerInfo

    // Get raw file descriptors from each listener
    for _, l := range m.listeners {
        f, err := l.File()
        if err != nil {
            return fmt.Errorf("getting file from listener: %w", err)
        }
        defer f.Close()

        addr := l.Addr()
        infos = append(infos, ListenerInfo{
            Addr:    addr.String(),
            Network: addr.Network(),
            FD:      f.Fd(),
        })
        files = append(files, f)
    }

    // Marshal listener info for the child
    infoJSON, err := json.Marshal(infos)
    if err != nil {
        return fmt.Errorf("marshaling listener info: %w", err)
    }

    // Build child command
    cmd := exec.Command(os.Args[0], os.Args[1:]...)
    cmd.Stdout = os.Stdout
    cmd.Stderr = os.Stderr
    cmd.Env = append(os.Environ(),
        fmt.Sprintf("%s=true", envRestart),
        fmt.Sprintf("%s=%s", envListenerFDs, string(infoJSON)),
    )
    // Inherit the file descriptors
    cmd.ExtraFiles = files

    if err := cmd.Start(); err != nil {
        return fmt.Errorf("starting child process: %w", err)
    }

    return nil
}

// IsRestart returns true if this process was started via restart.
func IsRestart() bool {
    return os.Getenv(envRestart) == "true"
}

// InheritedListeners returns listeners from a parent restart.
func InheritedListeners() ([]*net.TCPListener, error) {
    if !IsRestart() {
        return nil, nil
    }

    infoJSON := os.Getenv(envListenerFDs)
    if infoJSON == "" {
        return nil, nil
    }

    var infos []ListenerInfo
    if err := json.Unmarshal([]byte(infoJSON), &infos); err != nil {
        return nil, fmt.Errorf("parsing listener info: %w", err)
    }

    // Reconstruct listeners from inherited fds
    // ExtraFiles start at fd 3
    var listeners []*net.TCPListener
    for i, info := range infos {
        fd := uintptr(3 + i)
        f := os.NewFile(fd, info.Addr)
        if f == nil {
            return nil, fmt.Errorf("invalid fd %d for %s", fd, info.Addr)
        }

        l, err := net.FileListener(f)
        if err != nil {
            return nil, fmt.Errorf("creating listener from fd %d: %w", fd, err)
        }
        f.Close() // The listener now owns the fd

        tcpL, ok := l.(*net.TCPListener)
        if !ok {
            return nil, fmt.Errorf("listener %s is not TCP", info.Addr)
        }
        listeners = append(listeners, tcpL)
    }

    return listeners, nil
}
```

### Full Zero-Downtime HTTP Server

```go
// cmd/server/main.go — zero-downtime restart with SIGUSR2
package main

import (
    "context"
    "fmt"
    "log/slog"
    "net"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "myapp/pkg/graceful"
)

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

    var listener *net.TCPListener

    // Check if we inherited a listener from a graceful restart
    inherited, err := graceful.InheritedListeners()
    if err != nil {
        logger.Error("failed to get inherited listeners", "error", err)
        os.Exit(1)
    }

    if len(inherited) > 0 {
        listener = inherited[0]
        logger.Info("using inherited listener from parent",
            "addr", listener.Addr())
    } else {
        // First start — bind the socket
        tcpAddr, err := net.ResolveTCPAddr("tcp", "0.0.0.0:8080")
        if err != nil {
            logger.Error("failed to resolve addr", "error", err)
            os.Exit(1)
        }
        listener, err = net.ListenTCP("tcp", tcpAddr)
        if err != nil {
            logger.Error("failed to listen", "error", err)
            os.Exit(1)
        }
        logger.Info("bound new socket", "addr", listener.Addr())
    }

    mux := http.NewServeMux()
    mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        fmt.Fprintf(w, "PID: %d\n", os.Getpid())
    })

    srv := &http.Server{
        Handler:      mux,
        ReadTimeout:  30 * time.Second,
        WriteTimeout: 30 * time.Second,
    }

    // Signal handling
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM, syscall.SIGUSR2)

    // Start serving
    errCh := make(chan error, 1)
    go func() {
        logger.Info("serving", "pid", os.Getpid())
        if err := srv.Serve(listener); err != nil && err != http.ErrServerClosed {
            errCh <- err
        }
    }()

    select {
    case sig := <-sigCh:
        logger.Info("received signal", "signal", sig.String(), "pid", os.Getpid())

        if sig == syscall.SIGUSR2 {
            // Zero-downtime restart: fork a new process with the listener
            logger.Info("initiating zero-downtime restart")

            mgr := graceful.NewManager(listener)
            if err := mgr.Restart(); err != nil {
                logger.Error("restart failed", "error", err)
            } else {
                logger.Info("child process started successfully")
            }
        }

        // Graceful shutdown of this process
        ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
        defer cancel()

        logger.Info("shutting down gracefully")
        srv.Shutdown(ctx)

    case err := <-errCh:
        logger.Error("server error", "error", err)
        os.Exit(1)
    }

    logger.Info("shutdown complete", "pid", os.Getpid())
}
```

## Section 6: Socket Activation in Containers

Socket activation works in containers with some adaptation. The typical pattern is to run systemd inside a container or use a socket activation shim.

### Containerized Socket Activation with s6-overlay

```dockerfile
# Dockerfile
FROM ubuntu:24.04

# Install s6-overlay for process supervision
ADD https://github.com/just-containers/s6-overlay/releases/download/v3.1.6.2/s6-overlay-noarch.tar.xz /tmp/
RUN tar -C / -Jxpf /tmp/s6-overlay-noarch.tar.xz

# Copy service definitions
COPY rootfs /

# The service listens on an inherited socket from s6
COPY myapp /usr/local/bin/myapp

ENTRYPOINT ["/init"]
```

### Kubernetes Pod with Socket Volume

```yaml
# socket-activation-pod.yaml
# Pattern: init container creates the socket, main container inherits it
apiVersion: v1
kind: Pod
metadata:
  name: socket-activated-app
spec:
  initContainers:
    - name: socket-creator
      image: busybox
      command:
        - sh
        - -c
        - |
          # Pre-create socket directory with proper permissions
          mkdir -p /run/myapp
          chmod 750 /run/myapp
      volumeMounts:
        - name: socket-dir
          mountPath: /run/myapp

  containers:
    - name: myapp
      image: myrepo/myapp:latest
      # Pass socket fd via environment or file
      env:
        - name: LISTEN_ADDR
          value: /run/myapp/http.sock
      volumeMounts:
        - name: socket-dir
          mountPath: /run/myapp
      readinessProbe:
        exec:
          command: ["/usr/bin/test", "-S", "/run/myapp/http.sock"]
        initialDelaySeconds: 5
        periodSeconds: 2

    - name: nginx-proxy
      image: nginx:alpine
      volumeMounts:
        - name: socket-dir
          mountPath: /run/myapp
        - name: nginx-config
          mountPath: /etc/nginx/conf.d

  volumes:
    - name: socket-dir
      emptyDir: {}
    - name: nginx-config
      configMap:
        name: nginx-socket-proxy-config
```

## Section 7: Testing Socket Activation

### Unit Testing with Fake Sockets

```go
// pkg/graceful/activation_test.go
package graceful_test

import (
    "fmt"
    "io"
    "net"
    "net/http"
    "os"
    "testing"
    "time"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

// simulateSocketActivation creates a listener and sets up the environment
// to simulate what systemd does during socket activation.
func simulateSocketActivation(t *testing.T) (*net.TCPListener, func()) {
    t.Helper()

    // Create a TCP listener
    l, err := net.Listen("tcp", "127.0.0.1:0")
    require.NoError(t, err)

    tcpL := l.(*net.TCPListener)

    // Get the raw file descriptor
    f, err := tcpL.File()
    require.NoError(t, err)

    // Dup the fd to fd 3 (SD_LISTEN_FDS_START)
    err = syscall.Dup2(int(f.Fd()), 3)
    require.NoError(t, err)
    f.Close()

    // Set environment variables
    t.Setenv("LISTEN_FDS", "1")
    t.Setenv("LISTEN_PID", fmt.Sprintf("%d", os.Getpid()))
    t.Setenv("LISTEN_FDNAMES", "http")

    cleanup := func() {
        os.Unsetenv("LISTEN_FDS")
        os.Unsetenv("LISTEN_PID")
        os.Unsetenv("LISTEN_FDNAMES")
    }

    return tcpL, cleanup
}

func TestHTTPServerSocketActivation(t *testing.T) {
    _, cleanup := simulateSocketActivation(t)
    defer cleanup()

    // Import the activation package
    // This would use the real go-systemd activation in tests
    listeners, err := activation.Listeners()
    require.NoError(t, err)
    require.Len(t, listeners, 1)

    srv := &http.Server{
        Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            fmt.Fprintln(w, "socket activated")
        }),
    }
    go srv.Serve(listeners[0])
    defer srv.Close()

    // Make a request
    addr := listeners[0].Addr().String()
    resp, err := http.Get(fmt.Sprintf("http://%s/", addr))
    require.NoError(t, err)
    defer resp.Body.Close()

    body, _ := io.ReadAll(resp.Body)
    assert.Equal(t, "socket activated\n", string(body))
}
```

### systemd-socket-activate Testing Tool

```bash
# Test socket activation without installing systemd service
# The systemd-socket-activate tool simulates what systemd does

systemd-socket-activate \
    --listen 0.0.0.0:8080 \
    --fdname http \
    /opt/myapp/bin/myapp serve

# Test with multiple sockets
systemd-socket-activate \
    --listen 0.0.0.0:8080 \
    --listen 0.0.0.0:9090 \
    --fdname http:grpc \
    /opt/myapp/bin/myapp serve

# Test the zero-downtime restart
# Terminal 1: Start the service
systemd-socket-activate --listen 0.0.0.0:8080 /opt/myapp/bin/myapp

# Terminal 2: Generate continuous traffic
while true; do curl -s localhost:8080/; sleep 0.1; done

# Terminal 3: Trigger a zero-downtime restart
kill -USR2 $(pgrep myapp)
# No errors should appear in Terminal 2 during the restart
```

### Service Verification Script

```bash
#!/bin/bash
# verify-socket-activation.sh

SERVICE="myapp"
SOCKET="${SERVICE}.socket"
TIMEOUT=30

echo "=== Testing Socket Activation for $SERVICE ==="

# Check socket unit
echo "1. Checking socket unit..."
systemctl is-active "$SOCKET"
echo "   Socket state: $(systemctl show -p ActiveState "$SOCKET" | cut -d= -f2)"

# Check if socket is listening
echo "2. Checking socket listening..."
ss -tlnp | grep -E ":8080|:8443|:9090"

# Start the service and check activation
echo "3. Testing lazy activation..."
systemctl stop "$SERVICE" 2>/dev/null || true

# Socket should still be active after service stop
systemctl is-active "$SOCKET" && echo "   Socket still active (correct)"

# Send a request — should trigger service start
echo "4. Sending test request (triggers service activation)..."
RESPONSE=$(curl -s --max-time $TIMEOUT http://localhost:8080/health)
echo "   Response: $RESPONSE"

# Verify service started
systemctl is-active "$SERVICE" && echo "   Service activated by request (correct)"

# Test zero-downtime restart
echo "5. Testing zero-downtime restart..."
# Count errors during restart
ERROR_COUNT=0
for i in $(seq 1 50); do
    if ! curl -sf --max-time 2 http://localhost:8080/health > /dev/null 2>&1; then
        ERROR_COUNT=$((ERROR_COUNT + 1))
    fi
    sleep 0.1
    if [ $i -eq 10 ]; then
        # Restart at iteration 10
        systemctl restart "$SERVICE"
    fi
done

echo "   Errors during restart: $ERROR_COUNT / 50"
if [ $ERROR_COUNT -eq 0 ]; then
    echo "   PASS: Zero-downtime restart successful"
else
    echo "   FAIL: $ERROR_COUNT requests failed during restart"
fi

echo "=== Test complete ==="
```

Socket activation is one of the most operationally powerful features of systemd. Combined with Go's ability to accept pre-bound file descriptors, it enables true zero-downtime deployments where connection loss during service restarts becomes a solved problem rather than an accepted limitation.
