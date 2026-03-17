---
title: "Linux Process Signals: Signal Handling, Real-Time Signals, and Graceful Shutdown Patterns"
date: 2030-04-20T00:00:00-05:00
draft: false
tags: ["Linux", "Signals", "POSIX", "Graceful Shutdown", "Go", "Python", "C", "Process Management"]
categories: ["Linux", "Systems Programming"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to POSIX signal handling in C, Go, and Python: real-time signal queues, sigaction vs signal, graceful shutdown with SIGTERM, signal masks, SIGCHLD handling for process supervisors, and production patterns."
more_link: "yes"
url: "/linux-process-signals-handling-realtime-graceful-shutdown/"
---

Signals are the Unix IPC mechanism for asynchronous process notification. They appear simple — send a signal, catch it in a handler — but the details hide significant complexity. Signal handlers run asynchronously, interrupting whatever the process was doing, which means they must be async-signal-safe: calling `printf` from a signal handler is undefined behavior. Real-time signals provide queuing and priority. In Go, signals are delivered via channels, which sidesteps most of the async-safety problems. In Python, signals are handled in the main thread after the current bytecode instruction completes. Understanding these differences is the foundation for implementing correct graceful shutdown, process supervision, and SIGCHLD-based child process management.

<!--more-->

## Signal Fundamentals

### Signal Taxonomy

```
Standard POSIX Signals (non-queued, can be coalesced):
Signal  Number  Default Action  Description
SIGHUP    1     Terminate       Hangup / reload config
SIGINT    2     Terminate       Keyboard interrupt (Ctrl+C)
SIGQUIT   3     Core dump       Keyboard quit (Ctrl+\)
SIGILL    4     Core dump       Illegal instruction
SIGABRT   6     Core dump       abort() call
SIGFPE    8     Core dump       Floating point exception
SIGKILL   9     Terminate       Cannot be caught or ignored
SIGSEGV  11     Core dump       Segmentation fault
SIGPIPE  13     Terminate       Broken pipe
SIGALRM  14     Terminate       Timer alarm
SIGTERM  15     Terminate       Graceful termination request
SIGUSR1  10     Terminate       User-defined signal 1
SIGUSR2  12     Terminate       User-defined signal 2
SIGCHLD  17     Ignore          Child process state change
SIGCONT  18     Continue        Continue stopped process
SIGSTOP  19     Stop            Cannot be caught or ignored
SIGTSTP  20     Stop            Keyboard stop (Ctrl+Z)

Real-Time Signals (queued, FIFO within same priority):
SIGRTMIN (34) through SIGRTMAX (64)
- Guaranteed delivery ordering within same priority
- Carry a siginfo value (payload)
- Can be queued multiple times
- Used for: POSIX timers, AIO completion, custom IPC
```

### Async-Signal-Safe Functions

Only async-signal-safe functions may be called from signal handlers. The POSIX standard provides a list; most IO functions are NOT on it.

```c
/* SAFE to call from signal handlers (POSIX async-signal-safe): */
write()      /* but NOT printf() */
read()
open()
close()
_exit()      /* but NOT exit() */
kill()
getpid()
sigaction()
sigemptyset()
sigfillset()
sigaddset()
sigdelset()
sigprocmask()
waitpid()
/* Most math functions */

/* NOT safe from signal handlers: */
malloc()     /* uses internal locks */
printf()     /* uses FILE* locking */
exit()       /* calls atexit handlers */
syslog()
pthread_mutex_lock()
/* Most libc functions that use global state */
```

## Signal Handling in C

### sigaction vs signal

Never use `signal()` in new code. It has implementation-defined semantics. Always use `sigaction()`.

```c
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>

/* Global flag - volatile sig_atomic_t for signal-safe access */
static volatile sig_atomic_t shutdown_requested = 0;
static volatile sig_atomic_t reload_requested   = 0;

/* Signal handler - must be async-signal-safe */
static void signal_handler(int signum) {
    switch (signum) {
    case SIGTERM:
    case SIGINT:
        shutdown_requested = 1;
        break;
    case SIGHUP:
        reload_requested = 1;
        break;
    }
    /* Note: just setting a flag, no printf or malloc */
}

/* Install a signal handler using sigaction */
int install_handler(int signum, void (*handler)(int), int flags) {
    struct sigaction sa;
    memset(&sa, 0, sizeof(sa));

    sa.sa_handler = handler;
    sa.sa_flags   = flags;

    /* Block all signals during handler execution */
    sigfillset(&sa.sa_mask);

    if (sigaction(signum, &sa, NULL) < 0) {
        perror("sigaction");
        return -1;
    }
    return 0;
}

/* Write message to stderr from signal handler (async-safe) */
static void async_write(const char *msg) {
    ssize_t n = strlen(msg);
    while (n > 0) {
        ssize_t w = write(STDERR_FILENO, msg, (size_t)n);
        if (w < 0) {
            if (errno == EINTR) continue;
            break;
        }
        n -= w;
        msg += w;
    }
}

int main(void) {
    /* Install handlers */
    install_handler(SIGTERM, signal_handler, 0);
    install_handler(SIGINT,  signal_handler, 0);
    install_handler(SIGHUP,  signal_handler, 0);

    /* Ignore SIGPIPE - handle broken pipes via return codes */
    signal(SIGPIPE, SIG_IGN);

    printf("PID %d: running. Send SIGTERM/SIGINT to stop, SIGHUP to reload.\n",
           getpid());

    /* Main loop: check flags set by signal handlers */
    while (!shutdown_requested) {
        if (reload_requested) {
            reload_requested = 0;
            printf("Reloading configuration...\n");
            /* reload config here */
        }

        /* Do work... */
        sleep(1);
    }

    printf("Shutdown requested, cleaning up...\n");
    /* cleanup here */
    return 0;
}
```

### Self-Pipe Trick for select/epoll Compatibility

Signal handlers cannot call `select()` or `epoll_wait()`. The self-pipe trick creates a pipe; the signal handler writes a byte to the write end; the main loop detects the readable pipe fd.

```c
#include <signal.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/select.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>

static int signal_pipe[2]; /* [0]=read, [1]=write */

static void pipe_signal_handler(int signum) {
    /* Write the signal number - async-signal-safe */
    unsigned char sig = (unsigned char)signum;
    ssize_t r;
    do {
        r = write(signal_pipe[1], &sig, 1);
    } while (r < 0 && errno == EINTR);
}

int setup_signal_pipe(void) {
    if (pipe(signal_pipe) < 0) {
        perror("pipe");
        return -1;
    }

    /* Make write end non-blocking to avoid blocking in signal handler */
    int flags = fcntl(signal_pipe[1], F_GETFL);
    fcntl(signal_pipe[1], F_SETFL, flags | O_NONBLOCK);

    return 0;
}

int main(void) {
    if (setup_signal_pipe() < 0) return 1;

    struct sigaction sa;
    memset(&sa, 0, sizeof(sa));
    sa.sa_handler = pipe_signal_handler;
    sigemptyset(&sa.sa_mask);
    sigaction(SIGTERM, &sa, NULL);
    sigaction(SIGINT,  &sa, NULL);
    sigaction(SIGHUP,  &sa, NULL);

    printf("PID %d: using self-pipe for signal delivery\n", getpid());

    int server_fd = -1; /* your actual server socket here */

    while (1) {
        fd_set readfds;
        FD_ZERO(&readfds);
        FD_SET(signal_pipe[0], &readfds);
        if (server_fd >= 0) FD_SET(server_fd, &readfds);

        int nfds = signal_pipe[0] + 1;
        if (server_fd >= nfds) nfds = server_fd + 1;

        int r = select(nfds, &readfds, NULL, NULL, NULL);
        if (r < 0) {
            if (errno == EINTR) continue;
            perror("select");
            break;
        }

        if (FD_ISSET(signal_pipe[0], &readfds)) {
            unsigned char sig;
            if (read(signal_pipe[0], &sig, 1) == 1) {
                printf("Received signal: %d\n", (int)sig);
                if (sig == SIGTERM || sig == SIGINT) break;
                if (sig == SIGHUP) printf("Reloading...\n");
            }
        }

        if (server_fd >= 0 && FD_ISSET(server_fd, &readfds)) {
            /* handle client connection */
        }
    }

    printf("Graceful shutdown complete\n");
    return 0;
}
```

## Real-Time Signals

Real-time signals (SIGRTMIN through SIGRTMAX) are queued and delivered in FIFO order within the same priority. They can carry a payload via `sigqueue()`.

```c
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

/* Real-time signal handler with siginfo */
static void rt_handler(int signum, siginfo_t *info, void *context) {
    (void)context;
    /* info->si_value carries the payload from sigqueue() */
    int value = info->si_value.sival_int;
    
    /* Only write() is async-signal-safe, not printf() */
    char buf[64];
    int n = snprintf(buf, sizeof(buf),
                     "RT signal %d received, value=%d, pid=%d\n",
                     signum, value, (int)info->si_pid);
    write(STDERR_FILENO, buf, (size_t)n);
}

int setup_rt_signal(int signum) {
    struct sigaction sa;
    sa.sa_sigaction = rt_handler;
    sa.sa_flags     = SA_SIGINFO;  /* use sa_sigaction, not sa_handler */
    sigemptyset(&sa.sa_mask);

    return sigaction(signum, &sa, NULL);
}

/* Sender process: use sigqueue to send RT signal with value */
int send_rt_signal(pid_t target_pid, int signum, int value) {
    union sigval sv;
    sv.sival_int = value;
    return sigqueue(target_pid, signum, sv);
}

int main(void) {
    int rt_sig = SIGRTMIN + 1;  /* Use SIGRTMIN+N to avoid conflicts */

    if (setup_rt_signal(rt_sig) < 0) {
        perror("sigaction");
        return 1;
    }

    printf("PID %d: waiting for RT signal %d\n", getpid(), rt_sig);
    printf("Send with: kill -%d %d\n", rt_sig, getpid());
    printf("Or: python3 -c \"import os,signal; os.kill(%d, %d)\"\n",
           getpid(), rt_sig);

    /* Demo: send multiple RT signals to ourselves (they queue) */
    for (int i = 1; i <= 5; i++) {
        send_rt_signal(getpid(), rt_sig, i * 100);
    }

    /* Process them all */
    for (int i = 0; i < 5; i++) {
        pause(); /* wait for one signal */
    }

    return 0;
}
```

## Signal Handling in Go

Go's signal handling uses channels, which avoids all async-signal-safety issues. The `signal.Notify` function registers a channel to receive OS signals.

### Production Graceful Shutdown in Go

```go
package main

import (
    "context"
    "errors"
    "fmt"
    "log"
    "net"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"
)

type Server struct {
    http     *http.Server
    db       interface{ Close() error }
    listener net.Listener
}

func NewServer(addr string) (*Server, error) {
    mux := http.NewServeMux()
    mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
        w.Write([]byte("ok"))
    })
    mux.HandleFunc("/api/data", func(w http.ResponseWriter, r *http.Request) {
        // Simulate work
        select {
        case <-time.After(100 * time.Millisecond):
            fmt.Fprintln(w, `{"status":"ok"}`)
        case <-r.Context().Done():
            // Request was cancelled (e.g., by graceful shutdown)
        }
    })

    srv := &Server{
        http: &http.Server{
            Addr:         addr,
            Handler:      mux,
            ReadTimeout:  10 * time.Second,
            WriteTimeout: 30 * time.Second,
            IdleTimeout:  120 * time.Second,
        },
    }

    return srv, nil
}

// Run starts the server and blocks until shutdown is complete
func (s *Server) Run() error {
    // Channel to receive signals - buffer prevents blocking the OS
    sigCh := make(chan os.Signal, 2)
    signal.Notify(sigCh,
        syscall.SIGTERM, // Kubernetes sends this for pod termination
        syscall.SIGINT,  // Ctrl+C in development
        syscall.SIGHUP,  // Config reload
    )
    defer signal.Stop(sigCh)

    // Start the server in a goroutine
    serverErr := make(chan error, 1)
    go func() {
        log.Printf("Server listening on %s", s.http.Addr)
        if err := s.http.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
            serverErr <- err
        }
    }()

    // Wait for signal or server error
    for {
        select {
        case sig := <-sigCh:
            switch sig {
            case syscall.SIGHUP:
                log.Printf("Received SIGHUP: reloading configuration")
                s.reloadConfig()
                continue // keep running

            case syscall.SIGTERM, syscall.SIGINT:
                log.Printf("Received %s: initiating graceful shutdown", sig)
                return s.gracefulShutdown()
            }

        case err := <-serverErr:
            return fmt.Errorf("server error: %w", err)
        }
    }
}

func (s *Server) gracefulShutdown() error {
    // Allow up to 30 seconds for in-flight requests to complete
    // Kubernetes default terminationGracePeriodSeconds is 30s
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    log.Printf("Shutting down HTTP server (max 30s)...")
    if err := s.http.Shutdown(ctx); err != nil {
        log.Printf("HTTP server shutdown error: %v", err)
        return err
    }

    // Close database connections
    if s.db != nil {
        log.Printf("Closing database connections...")
        if err := s.db.Close(); err != nil {
            log.Printf("DB close error: %v", err)
        }
    }

    log.Printf("Graceful shutdown complete")
    return nil
}

func (s *Server) reloadConfig() {
    log.Printf("Config reloaded (placeholder)")
    // Reload TLS certificates, re-read config files, etc.
}

func main() {
    srv, err := NewServer(":8080")
    if err != nil {
        log.Fatalf("Failed to create server: %v", err)
    }

    if err := srv.Run(); err != nil {
        log.Fatalf("Server error: %v", err)
    }
    log.Printf("Server exited cleanly")
}
```

### Signal Masking and Blocking in Go

```go
package main

import (
    "fmt"
    "os"
    "os/signal"
    "syscall"
    "time"
)

// Demonstrate signal masking
func demonstrateSignalMasking() {
    // Block SIGINT during a critical section
    // Note: In Go, this is done per-goroutine for the OS-level masking
    // but signal.Ignore/signal.Reset handle it at the Go runtime level

    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGINT)

    fmt.Println("Critical section starting - SIGINT buffered (not dropped)")
    fmt.Println("Press Ctrl+C now to test buffering...")

    // During this critical section, signals are buffered in sigCh
    time.Sleep(5 * time.Second)

    // Check for buffered signals
    select {
    case sig := <-sigCh:
        fmt.Printf("Received buffered signal: %v\n", sig)
    default:
        fmt.Println("No signal received during critical section")
    }

    signal.Stop(sigCh)
    fmt.Println("Critical section complete")
}

// Multiple signal types with priority handling
func multiSignalHandler() {
    termCh  := make(chan os.Signal, 1)
    hupCh   := make(chan os.Signal, 1)
    usr1Ch  := make(chan os.Signal, 1)

    signal.Notify(termCh,  syscall.SIGTERM, syscall.SIGINT)
    signal.Notify(hupCh,   syscall.SIGHUP)
    signal.Notify(usr1Ch,  syscall.SIGUSR1)

    defer func() {
        signal.Stop(termCh)
        signal.Stop(hupCh)
        signal.Stop(usr1Ch)
    }()

    ticker := time.NewTicker(1 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case sig := <-termCh:
            fmt.Printf("Terminating on signal: %v\n", sig)
            return

        case <-hupCh:
            fmt.Println("SIGHUP: reloading configuration")

        case <-usr1Ch:
            fmt.Println("SIGUSR1: dumping statistics")
            // In production: dump goroutine stack, print metrics, etc.
            // pprof.Lookup("goroutine").WriteTo(os.Stdout, 1)

        case t := <-ticker.C:
            fmt.Printf("Working... %v\n", t)
        }
    }
}
```

## Signal Handling in Python

Python delivers signals only between bytecode instructions in the main thread. Signal handlers set in non-main threads are ignored by the OS, though Go-style signal delivery can be simulated with `signal.set_wakeup_fd`.

```python
#!/usr/bin/env python3
"""Production signal handling patterns in Python."""

import asyncio
import logging
import os
import signal
import socket
import sys
import threading
import time

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(message)s'
)
logger = logging.getLogger(__name__)


# Pattern 1: Simple flag-based handler (synchronous code)
class SynchronousApp:
    def __init__(self):
        self._running = False
        self._reload = False
        self._install_handlers()

    def _install_handlers(self):
        signal.signal(signal.SIGTERM, self._handle_term)
        signal.signal(signal.SIGINT,  self._handle_term)
        signal.signal(signal.SIGHUP,  self._handle_hup)

    def _handle_term(self, signum, frame):
        logger.info("Received signal %d, shutting down", signum)
        self._running = False

    def _handle_hup(self, signum, frame):
        logger.info("Received SIGHUP, reloading")
        self._reload = True

    def run(self):
        self._running = True
        logger.info("PID %d: running", os.getpid())

        while self._running:
            if self._reload:
                self._reload = False
                logger.info("Reloading configuration...")

            # Do work
            time.sleep(0.1)

        logger.info("Shutdown complete")


# Pattern 2: asyncio with signal handlers
class AsyncApp:
    def __init__(self):
        self._loop = None
        self._shutdown_event = None

    async def run(self):
        self._loop = asyncio.get_running_loop()
        self._shutdown_event = asyncio.Event()

        # Register signal handlers on the event loop
        for sig in (signal.SIGTERM, signal.SIGINT):
            self._loop.add_signal_handler(
                sig,
                lambda s=sig: asyncio.create_task(self._shutdown(s))
            )

        self._loop.add_signal_handler(
            signal.SIGHUP,
            lambda: asyncio.create_task(self._reload())
        )

        logger.info("Async app running, PID %d", os.getpid())

        # Run until shutdown
        await self._main_loop()

        logger.info("Async app shutdown complete")

    async def _main_loop(self):
        """Main application loop."""
        tasks = []
        try:
            while not self._shutdown_event.is_set():
                # Create tasks for concurrent work
                task = asyncio.create_task(self._do_work())
                tasks.append(task)

                try:
                    await asyncio.wait_for(
                        asyncio.shield(self._shutdown_event.wait()),
                        timeout=1.0
                    )
                except asyncio.TimeoutError:
                    pass

        finally:
            # Cancel all running tasks
            for task in tasks:
                task.cancel()

            # Wait for cancellation to complete
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)

    async def _do_work(self):
        """Placeholder for real work."""
        try:
            await asyncio.sleep(0.5)
            logger.debug("Work cycle complete")
        except asyncio.CancelledError:
            logger.debug("Work task cancelled")
            raise

    async def _shutdown(self, signum: int):
        logger.info("Received signal %d, shutting down", signum)

        # Give in-flight requests time to complete
        await asyncio.sleep(0)  # yield to event loop

        self._shutdown_event.set()

    async def _reload(self):
        logger.info("Received SIGHUP, reloading configuration")
        # Reload config, certificates, etc.


# Pattern 3: set_wakeup_fd for signal delivery in select/poll loops
class SelectApp:
    def __init__(self):
        # Create a socket pair for signal wakeup
        self._r_sock, self._w_sock = socket.socketpair()
        self._r_sock.setblocking(False)
        self._w_sock.setblocking(False)

        # Set the write end as the wakeup fd
        signal.set_wakeup_fd(self._w_sock.fileno())

        signal.signal(signal.SIGTERM, signal.SIG_DFL)  # default action
        signal.signal(signal.SIGINT,  signal.SIG_DFL)
        signal.signal(signal.SIGHUP,  lambda s, f: None)  # custom handler

    def run(self):
        logger.info("Select-based app running, PID %d", os.getpid())

        import select as select_mod

        while True:
            r, _, _ = select_mod.select([self._r_sock], [], [], 1.0)

            if self._r_sock in r:
                # Read signal bytes
                data = self._r_sock.recv(256)
                for byte in data:
                    signum = byte
                    logger.info("Received signal %d", signum)

                    if signum in (signal.SIGTERM, signal.SIGINT):
                        logger.info("Graceful shutdown")
                        return
                    elif signum == signal.SIGHUP:
                        logger.info("Reloading configuration")

            # Normal work
            self._do_work()

    def _do_work(self):
        pass  # placeholder


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "sync"

    if mode == "sync":
        app = SynchronousApp()
        app.run()

    elif mode == "async":
        app = AsyncApp()
        asyncio.run(app.run())

    elif mode == "select":
        app = SelectApp()
        app.run()

    else:
        print(f"Unknown mode: {mode}")
        sys.exit(1)


if __name__ == "__main__":
    main()
```

## SIGCHLD Handling for Process Supervisors

A process supervisor launches child processes and monitors them via `SIGCHLD`. When a child exits, the supervisor reaps it with `waitpid()` and decides whether to restart it.

```c
#include <signal.h>
#include <sys/wait.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>

#define MAX_CHILDREN 16

typedef struct {
    pid_t  pid;
    char   cmd[256];
    int    restarts;
    int    max_restarts;
    time_t last_start;
} Child;

static Child children[MAX_CHILDREN];
static int   num_children = 0;
static volatile sig_atomic_t got_sigchld = 0;

static void sigchld_handler(int sig) {
    (void)sig;
    got_sigchld = 1;
    /* Do NOT call waitpid here - use the flag pattern */
}

/* Reap all zombie children */
static void reap_children(void) {
    int status;
    pid_t pid;

    /* Use WNOHANG to avoid blocking */
    while ((pid = waitpid(-1, &status, WNOHANG)) > 0) {
        /* Find which child exited */
        for (int i = 0; i < num_children; i++) {
            if (children[i].pid != pid) continue;

            if (WIFEXITED(status)) {
                printf("Child %d (cmd=%s) exited with status %d\n",
                       pid, children[i].cmd, WEXITSTATUS(status));
            } else if (WIFSIGNALED(status)) {
                printf("Child %d (cmd=%s) killed by signal %d\n",
                       pid, children[i].cmd, WTERMSIG(status));
            }

            /* Decide whether to restart */
            time_t now = time(NULL);
            if (children[i].restarts < children[i].max_restarts &&
                now - children[i].last_start > 1) { /* 1s crash cooldown */

                children[i].restarts++;
                children[i].last_start = now;

                pid_t new_pid = fork();
                if (new_pid == 0) {
                    /* Child process */
                    char *args[] = { children[i].cmd, NULL };
                    execv(children[i].cmd, args);
                    _exit(127); /* exec failed */
                } else if (new_pid > 0) {
                    children[i].pid = new_pid;
                    printf("Restarted %s as PID %d (restart %d/%d)\n",
                           children[i].cmd, new_pid,
                           children[i].restarts, children[i].max_restarts);
                }
            } else {
                printf("Child %s reached max restarts, not restarting\n",
                       children[i].cmd);
            }
            break;
        }
    }
}

int spawn_child(const char *cmd, int max_restarts) {
    if (num_children >= MAX_CHILDREN) return -1;

    Child *c = &children[num_children];
    strncpy(c->cmd, cmd, sizeof(c->cmd) - 1);
    c->max_restarts = max_restarts;
    c->restarts     = 0;
    c->last_start   = time(NULL);

    pid_t pid = fork();
    if (pid < 0) {
        perror("fork");
        return -1;
    }

    if (pid == 0) {
        /* Child: reset signal handlers to defaults */
        signal(SIGTERM, SIG_DFL);
        signal(SIGINT,  SIG_DFL);
        signal(SIGCHLD, SIG_DFL);

        /* Execute the child program */
        char *args[] = { (char *)cmd, NULL };
        execv(cmd, args);
        perror("execv");
        _exit(127);
    }

    c->pid = pid;
    num_children++;
    printf("Spawned %s as PID %d\n", cmd, pid);
    return 0;
}

int main(void) {
    struct sigaction sa;
    memset(&sa, 0, sizeof(sa));
    sa.sa_handler = sigchld_handler;
    sa.sa_flags   = SA_RESTART | SA_NOCLDSTOP;  /* don't get SIGCHLD for SIGSTOP */
    sigemptyset(&sa.sa_mask);
    sigaction(SIGCHLD, &sa, NULL);

    /* Ignore SIGPIPE */
    signal(SIGPIPE, SIG_IGN);

    /* Spawn some children (replace with real executables) */
    spawn_child("/bin/sleep", 3);

    printf("Supervisor PID %d running\n", getpid());

    while (1) {
        if (got_sigchld) {
            got_sigchld = 0;
            reap_children();
        }
        sleep(1);
    }
}
```

## Signal Masks for Critical Sections

```c
#include <signal.h>
#include <stdio.h>

/* Block signals during a critical section */
void critical_section_begin(sigset_t *old_mask) {
    sigset_t block_mask;
    sigfillset(&block_mask);

    /* Keep SIGKILL and SIGSTOP unblockable (kernel enforced) */
    sigdelset(&block_mask, SIGKILL);
    sigdelset(&block_mask, SIGSTOP);

    /* Block all blockable signals, save old mask */
    sigprocmask(SIG_BLOCK, &block_mask, old_mask);
}

void critical_section_end(sigset_t *old_mask) {
    /* Restore old signal mask - any pending signals will be delivered */
    sigprocmask(SIG_SETMASK, old_mask, NULL);
}

/* Usage */
void update_data_structure(void) {
    sigset_t old_mask;
    critical_section_begin(&old_mask);

    /* This code runs without signal interruption */
    /* Safe to modify shared state here */

    critical_section_end(&old_mask);
    /* Any signals that arrived during the critical section
     * are now delivered here */
}

/* Wait for a specific signal using sigwaitinfo */
int wait_for_signal(int signum, siginfo_t *info) {
    sigset_t wait_set;
    sigemptyset(&wait_set);
    sigaddset(&wait_set, signum);

    /* Block the signal first (so sigwaitinfo can atomically wait for it) */
    sigprocmask(SIG_BLOCK, &wait_set, NULL);

    /* Wait for the signal - this is synchronous, not async */
    return sigwaitinfo(&wait_set, info);
}
```

## Kubernetes Signal Flow

Understanding how Kubernetes delivers SIGTERM is critical for getting graceful shutdown right:

```
User: kubectl delete pod my-pod
          |
          v
API Server marks pod for deletion
          |
          v
kubelet: calls CRI to stop container
          |
          +-- Runs preStop hook (if defined) - blocks until complete
          |
          +-- Sends SIGTERM to PID 1 in container
          |
          +-- Waits terminationGracePeriodSeconds (default: 30s)
          |
          +-- If pod still running: sends SIGKILL
          |
          v
Container exits (or is killed)
```

```yaml
# Pod configuration for graceful shutdown
apiVersion: v1
kind: Pod
spec:
  terminationGracePeriodSeconds: 60  # give 60s for shutdown
  containers:
  - name: app
    lifecycle:
      preStop:
        exec:
          command: ["/bin/sh", "-c", "sleep 5"]
          # preStop adds 5s before SIGTERM is sent
          # Total graceful period = preStop + terminationGracePeriodSeconds
    # Alternatively:
    # preStop:
    #   httpGet:
    #     path: /shutdown
    #     port: 8080
```

## Key Takeaways

Signals are a critical part of Linux process management that every production service must handle correctly. The key principles:

**Async-signal-safety in C**: Signal handlers must only call async-signal-safe functions. The safe pattern is to set a `volatile sig_atomic_t` flag in the handler and check it in the main loop. For `select/epoll` event loops, use the self-pipe trick to convert signals into readable file descriptor events.

**sigaction over signal**: The `signal()` function has implementation-defined semantics. Always use `sigaction()` with explicit flag control. Use `SA_RESTART` to automatically restart interrupted system calls, and `SA_NOCLDSTOP` with SIGCHLD to avoid receiving signals for stopped children.

**Real-time signals**: Use SIGRTMIN+N offsets for application-defined real-time signals. They queue rather than coalesce, and carry a payload via `sigqueue()`. Useful for high-precision timing, AIO completion notification, and inter-process messaging.

**Go signal handling**: The channel-based approach is inherently async-signal-safe. Buffer your signal channels (`make(chan os.Signal, 2)`) to prevent the OS from dropping signals when the channel is full. Always call `signal.Stop(ch)` in a defer to prevent goroutine leaks.

**Python signal handling**: asyncio's `loop.add_signal_handler()` is the correct approach for async applications. The `signal.set_wakeup_fd()` mechanism integrates signals with `select/poll` event loops. Never install signal handlers from non-main threads.

**SIGCHLD and process supervision**: Always use `waitpid(-1, &status, WNOHANG)` in a loop inside the SIGCHLD handler context, not in the handler itself. The flag + main-loop pattern avoids re-entrancy issues. Use `SA_NOCLDSTOP` to avoid receiving SIGCHLD when children are suspended with SIGSTOP.

**Kubernetes SIGTERM**: Structure your application to: stop accepting new requests immediately on SIGTERM, complete in-flight requests within `terminationGracePeriodSeconds`, then exit cleanly. The preStop hook can add a brief delay to allow load balancers to drain connections before SIGTERM is sent.
