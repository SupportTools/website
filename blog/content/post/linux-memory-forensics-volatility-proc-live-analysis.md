---
title: "Linux Memory Forensics: Volatility, /proc, and Live Analysis"
date: 2029-10-01T00:00:00-05:00
draft: false
tags: ["Linux", "Security", "Forensics", "Memory Analysis", "Volatility", "Incident Response"]
categories: ["Linux", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Linux memory forensics covering /proc/PID/mem reading, smaps analysis, live process memory extraction, Volatility3 for memory images, and container-specific memory forensics techniques."
more_link: "yes"
url: "/linux-memory-forensics-volatility-proc-live-analysis/"
---

Memory forensics is one of the most powerful — and often underutilized — techniques in incident response and security analysis. While disk forensics can reveal what files existed on a system, memory forensics reveals what was actually running: decrypted data, in-memory credentials, network connections established by malware, injected code, and process state that was never written to disk.

This guide covers the complete Linux memory forensics toolkit, from live analysis using `/proc` pseudo-filesystem to full memory image analysis with Volatility3, with specific attention to container environments where traditional forensics approaches require adaptation.

<!--more-->

# Linux Memory Forensics: Volatility, /proc, and Live Analysis

## Section 1: Linux Memory Architecture

Understanding Linux memory management is prerequisite to forensics work.

### Virtual Memory Layout

Every Linux process has a virtual address space divided into segments:

```
High addresses (kernel space)
┌──────────────────────────┐
│ Kernel space             │ (not accessible to user processes)
├──────────────────────────┤ ~0x7fffffffffff (on x86-64)
│ Stack (grows down)       │
│ ...                      │
├──────────────────────────┤
│ Shared libraries (mmap)  │
├──────────────────────────┤
│ Heap (grows up)          │
├──────────────────────────┤
│ BSS segment (uninitialized data) │
├──────────────────────────┤
│ Data segment (initialized data)  │
├──────────────────────────┤
│ Text segment (code)      │
└──────────────────────────┘ 0x400000 (typical start)
```

### /proc as the Primary Interface

The `/proc` filesystem exposes process memory state:

```bash
# Key memory-related /proc files for a process
ls -la /proc/$PID/
# maps        — text representation of memory map
# smaps       — detailed memory map with statistics per region
# smaps_rollup — aggregated smaps statistics
# mem         — raw memory access (requires PTRACE_ATTACH or same UID)
# pagemap     — mapping of virtual to physical page frames
# status      — memory usage summary including VmRSS, VmSize, etc.
# environ     — process environment variables (can contain secrets)
# cmdline     — command line arguments
# fd/         — file descriptors
# fdinfo/     — file descriptor state
# net/        — network state
```

## Section 2: Reading /proc/PID/mem

`/proc/PID/mem` provides direct read/write access to a process's virtual memory. This is the foundation of live memory forensics.

### Reading Process Memory in Go

```go
package memread

import (
    "bufio"
    "encoding/hex"
    "fmt"
    "io"
    "os"
    "strconv"
    "strings"
    "syscall"
)

// MemoryRegion represents a single memory mapping.
type MemoryRegion struct {
    StartAddr uint64
    EndAddr   uint64
    Perms     string
    Offset    uint64
    DevMajor  int
    DevMinor  int
    Inode     uint64
    Pathname  string
    Size      uint64
}

// ParseMapsFile parses /proc/PID/maps into MemoryRegion structs.
func ParseMapsFile(pid int) ([]MemoryRegion, error) {
    path := fmt.Sprintf("/proc/%d/maps", pid)
    f, err := os.Open(path)
    if err != nil {
        return nil, fmt.Errorf("failed to open maps: %w", err)
    }
    defer f.Close()

    var regions []MemoryRegion
    scanner := bufio.NewScanner(f)

    for scanner.Scan() {
        line := scanner.Text()
        region, err := parseMapsLine(line)
        if err != nil {
            continue
        }
        regions = append(regions, region)
    }

    return regions, scanner.Err()
}

func parseMapsLine(line string) (MemoryRegion, error) {
    // Format: start-end perms offset dev inode pathname
    // e.g.: 55a7b8400000-55a7b8415000 r-xp 00000000 fd:01 1234567 /usr/bin/myapp
    parts := strings.Fields(line)
    if len(parts) < 5 {
        return MemoryRegion{}, fmt.Errorf("invalid maps line: %s", line)
    }

    addrRange := strings.Split(parts[0], "-")
    if len(addrRange) != 2 {
        return MemoryRegion{}, fmt.Errorf("invalid address range: %s", parts[0])
    }

    start, err := strconv.ParseUint(addrRange[0], 16, 64)
    if err != nil {
        return MemoryRegion{}, err
    }

    end, err := strconv.ParseUint(addrRange[1], 16, 64)
    if err != nil {
        return MemoryRegion{}, err
    }

    pathname := ""
    if len(parts) >= 6 {
        pathname = parts[5]
    }

    return MemoryRegion{
        StartAddr: start,
        EndAddr:   end,
        Perms:     parts[1],
        Pathname:  pathname,
        Size:      end - start,
    }, nil
}

// ReadProcessMemory reads bytes from a specific address in a process's memory.
// Requires either the same UID or CAP_SYS_PTRACE.
func ReadProcessMemory(pid int, addr uint64, size uint64) ([]byte, error) {
    // Attach to the process via ptrace to allow memory reading
    if err := syscall.PtraceAttach(pid); err != nil {
        return nil, fmt.Errorf("ptrace attach failed: %w", err)
    }
    defer syscall.PtraceDetach(pid)

    // Wait for the process to stop
    var status syscall.WaitStatus
    if _, err := syscall.Wait4(pid, &status, 0, nil); err != nil {
        return nil, fmt.Errorf("wait4 failed: %w", err)
    }

    // Open /proc/PID/mem
    memPath := fmt.Sprintf("/proc/%d/mem", pid)
    f, err := os.Open(memPath)
    if err != nil {
        return nil, fmt.Errorf("failed to open mem: %w", err)
    }
    defer f.Close()

    // Seek to the address
    if _, err := f.Seek(int64(addr), io.SeekStart); err != nil {
        return nil, fmt.Errorf("seek failed: %w", err)
    }

    // Read the bytes
    buf := make([]byte, size)
    n, err := f.Read(buf)
    if err != nil && err != io.EOF {
        return nil, fmt.Errorf("read failed: %w", err)
    }

    return buf[:n], nil
}

// DumpRegion dumps a memory region to a file for offline analysis.
func DumpRegion(pid int, region MemoryRegion, outputPath string) error {
    data, err := ReadProcessMemory(pid, region.StartAddr, region.Size)
    if err != nil {
        return fmt.Errorf("failed to read region: %w", err)
    }

    return os.WriteFile(outputPath, data, 0600)
}

// SearchMemory searches for a byte pattern across all readable regions.
func SearchMemory(pid int, pattern []byte) ([]MemoryMatch, error) {
    regions, err := ParseMapsFile(pid)
    if err != nil {
        return nil, err
    }

    var matches []MemoryMatch
    for _, region := range regions {
        // Only search readable, non-file-backed regions
        if !strings.Contains(region.Perms, "r") {
            continue
        }
        if region.Size > 512*1024*1024 { // Skip huge regions
            continue
        }

        data, err := ReadProcessMemory(pid, region.StartAddr, region.Size)
        if err != nil {
            continue // Skip unreadable regions
        }

        offsets := findPattern(data, pattern)
        for _, offset := range offsets {
            matches = append(matches, MemoryMatch{
                VirtualAddr: region.StartAddr + uint64(offset),
                Region:      region,
                Context:     contextBytes(data, offset, 32),
            })
        }
    }

    return matches, nil
}

type MemoryMatch struct {
    VirtualAddr uint64
    Region      MemoryRegion
    Context     []byte // Surrounding bytes for context
}

func findPattern(data, pattern []byte) []int {
    var offsets []int
    for i := 0; i <= len(data)-len(pattern); i++ {
        match := true
        for j, b := range pattern {
            if data[i+j] != b {
                match = false
                break
            }
        }
        if match {
            offsets = append(offsets, i)
        }
    }
    return offsets
}
```

### Command-Line Memory Forensics Tools

```bash
# Read a specific memory range from a running process
# Uses process_vm_readv for efficiency (no ptrace attach)
cat > /tmp/read_mem.py <<'EOF'
#!/usr/bin/env python3
import sys
import ctypes
import struct

def read_process_memory(pid, addr, size):
    """Read memory from a running process using /proc/PID/mem"""
    try:
        with open(f'/proc/{pid}/mem', 'rb') as f:
            f.seek(addr)
            return f.read(size)
    except PermissionError:
        print(f"Need root or same UID to read /proc/{pid}/mem")
        sys.exit(1)

def parse_maps(pid):
    """Parse /proc/PID/maps and return list of (start, end, perms, name) tuples"""
    regions = []
    with open(f'/proc/{pid}/maps') as f:
        for line in f:
            parts = line.split()
            addrs = parts[0].split('-')
            start = int(addrs[0], 16)
            end = int(addrs[1], 16)
            perms = parts[1]
            name = parts[5] if len(parts) > 5 else ''
            regions.append((start, end, perms, name))
    return regions

if __name__ == '__main__':
    pid = int(sys.argv[1])
    regions = parse_maps(pid)
    for start, end, perms, name in regions:
        if 'r' in perms and (not name or name.startswith('[heap]')):
            print(f"Region: {start:#x}-{end:#x} {perms} {name}")
            # Look for credential patterns
            try:
                data = read_process_memory(pid, start, end - start)
                if b'password' in data.lower() or b'secret' in data.lower():
                    print("  WARNING: Potential credential found in heap!")
            except:
                pass
EOF
python3 /tmp/read_mem.py $TARGET_PID
```

## Section 3: smaps Analysis

`/proc/PID/smaps` provides detailed statistics for each memory mapping, including physical memory usage, swap usage, and huge page information.

```bash
# Analyze smaps for a process
cat /proc/$PID/smaps | head -60

# Example smaps entry:
# 55a7b8400000-55a7b8415000 r-xp 00000000 fd:01 1234567 /usr/bin/app
# Size:                 84 kB    ← Virtual size
# KernelPageSize:        4 kB
# MMUPageSize:           4 kB
# Rss:                  84 kB    ← Resident (physical) memory
# Pss:                  28 kB    ← Proportional (shared pages divided)
# Shared_Clean:         56 kB    ← Shared clean (from disk)
# Shared_Dirty:          0 kB    ← Shared dirty (modified, will be written)
# Private_Clean:        28 kB    ← Private clean
# Private_Dirty:         0 kB    ← Private dirty (will cause CoW on fork)
# Referenced:           84 kB
# Anonymous:             0 kB    ← Anonymous (not backed by file)
# AnonHugePages:         0 kB    ← THP usage
# Shared_Hugetlb:        0 kB
# Private_Hugetlb:       0 kB
# Swap:                  0 kB    ← Currently swapped out
# SwapPss:               0 kB
# Locked:                0 kB
# THPeligible:           0
# VmFlags: rd ex mr mw me dw sd
```

### smaps Analysis Script

```bash
#!/bin/bash
# analyze_smaps.sh — comprehensive smaps analysis for incident response

PID=$1
if [ -z "$PID" ]; then
    echo "Usage: $0 <PID>"
    exit 1
fi

echo "=== Process Memory Analysis for PID $PID ==="
echo "Command: $(cat /proc/$PID/cmdline | tr '\0' ' ')"
echo "Status:"
grep -E "Vm|Threads|Pid|State|Name" /proc/$PID/status | head -20

echo ""
echo "=== Memory Map Summary ==="
# Rollup provides aggregate stats
cat /proc/$PID/smaps_rollup 2>/dev/null || {
    # Fallback: calculate from smaps
    awk '
    /^[0-9a-f]/{region=$0}
    /^Rss/{rss+=$2}
    /^Pss/{pss+=$2}
    /^Swap/{swap+=$2}
    /^Anonymous/{anon+=$2}
    /^AnonHugePages/{thp+=$2}
    END{
        printf "Total RSS:  %d MB\n", rss/1024
        printf "Total PSS:  %d MB\n", pss/1024
        printf "Swap:       %d MB\n", swap/1024
        printf "Anonymous:  %d MB\n", anon/1024
        printf "THP:        %d MB\n", thp/1024
    }' /proc/$PID/smaps
}

echo ""
echo "=== Anonymous Memory Regions (potential heap/stack) ==="
awk '
/^[0-9a-f]/{
    split($0, a, " ")
    addr=a[1]; perms=a[2]; name=(length(a)>=6)?a[6]:""
    anon=0
}
/^Anonymous:/{anon=$2}
/^Swap:/{
    swap=$2
    if (anon>1024 || swap>0) {
        printf "%-30s %-10s anon=%d KB swap=%d KB\n", addr, name, anon, swap
    }
}' /proc/$PID/smaps | sort -k3 -rn | head -20

echo ""
echo "=== Suspicious: Executable Anonymous Regions (potential shellcode) ==="
awk '
/^[0-9a-f]/{
    split($0, a, " ")
    addr=a[1]; perms=a[2]; name=(length(a)>=6)?a[6]:""
    is_exec=0; is_anon=1
    if (perms ~ /x/) is_exec=1
    if (name != "") is_anon=0
    do_flag=(is_exec && is_anon)
}
/^Size:/{
    if (do_flag) printf "SUSPICIOUS: %s (exec+anon, size=%s)\n", addr, $2
}' /proc/$PID/smaps

echo ""
echo "=== Memory-Mapped Files ==="
awk '
/^[0-9a-f]/{
    split($0, a, " ")
    if (length(a)>=6 && a[6]!="" && a[6]!~/^\[/) {
        name=a[6]; perms=a[2]
        rss=0
    }
}
/^Rss:/{
    if (name!="") {
        rss=$2
        printf "%-50s %-10s %d KB\n", name, perms, rss
        name=""
    }
}' /proc/$PID/smaps | sort -u | sort -k3 -rn | head -20
```

## Section 4: Live Memory Dump for Analysis

Creating a complete memory image of a running process for offline analysis:

```bash
#!/bin/bash
# dump_process_memory.sh — creates a memory image from a running process

PID=$1
OUTPUT_DIR=${2:-/tmp/memdump_${PID}_$(date +%Y%m%d_%H%M%S)}
mkdir -p "$OUTPUT_DIR"

echo "Dumping memory for PID $PID to $OUTPUT_DIR"

# Save process metadata
cp /proc/$PID/maps "$OUTPUT_DIR/maps"
cp /proc/$PID/smaps "$OUTPUT_DIR/smaps"
cp /proc/$PID/status "$OUTPUT_DIR/status"
cp /proc/$PID/cmdline "$OUTPUT_DIR/cmdline"
cp /proc/$PID/environ "$OUTPUT_DIR/environ" 2>/dev/null
ls -la /proc/$PID/fd > "$OUTPUT_DIR/fd_list.txt"
cat /proc/$PID/net/tcp > "$OUTPUT_DIR/net_tcp.txt" 2>/dev/null
cat /proc/$PID/net/tcp6 > "$OUTPUT_DIR/net_tcp6.txt" 2>/dev/null

# Dump readable memory regions
echo "Dumping memory regions..."
DUMP_COUNT=0

while IFS= read -r line; do
    addr_range=$(echo "$line" | awk '{print $1}')
    perms=$(echo "$line" | awk '{print $2}')

    # Only dump readable regions
    if [[ ! $perms == r* ]]; then
        continue
    fi

    start=$(echo "${addr_range%-*}" | tr -d '[:space:]')
    end=$(echo "${addr_range#*-}" | tr -d '[:space:]')

    # Calculate size in hex
    start_dec=$((16#$start))
    end_dec=$((16#$end))
    size_dec=$((end_dec - start_dec))

    # Skip very large regions (>512MB) to avoid killing the system
    if [ $size_dec -gt $((512 * 1024 * 1024)) ]; then
        echo "Skipping large region: $addr_range ($((size_dec / 1024 / 1024)) MB)"
        continue
    fi

    outfile="$OUTPUT_DIR/region_${start}-${end}.bin"

    # Use dd to read from /proc/PID/mem
    dd if=/proc/$PID/mem \
        bs=1 \
        skip=$start_dec \
        count=$size_dec \
        of="$outfile" \
        2>/dev/null

    if [ $? -eq 0 ] && [ -s "$outfile" ]; then
        DUMP_COUNT=$((DUMP_COUNT + 1))
    else
        rm -f "$outfile"
    fi

done < /proc/$PID/maps

echo "Dumped $DUMP_COUNT memory regions"
echo "Output directory: $OUTPUT_DIR"

# Create a combined dump file
cat "$OUTPUT_DIR"/region_*.bin > "$OUTPUT_DIR/combined_heap.bin" 2>/dev/null
echo "Combined heap dump: $(du -sh "$OUTPUT_DIR/combined_heap.bin" 2>/dev/null)"
```

### Using gcore for Full Process Dump

```bash
# gcore creates a core dump of a running process without killing it
# Requires sudo or same UID
gcore -o /tmp/process_dump $PID

# The resulting file can be analyzed with gdb
gdb -q /usr/bin/target_program /tmp/process_dump.$PID

# In gdb:
(gdb) info proc mappings
(gdb) x/100s 0x55a7b8400000  # Examine as strings
(gdb) dump memory /tmp/heap_region.bin 0x55a7b8400000 0x55a7c8400000
(gdb) strings /tmp/heap_region.bin | grep -i "password\|token\|secret\|key"
```

## Section 5: Volatility3 for Memory Images

Volatility3 is the primary framework for analyzing full system memory images (vmcore files, libvirt snapshots, VM memory dumps).

### Installation and Setup

```bash
# Install Volatility3
pip3 install volatility3

# For kernel symbol tables, Volatility3 uses ISF (Intermediate Symbol Format)
# Download symbol tables for your kernel version
KERNEL_VERSION=$(uname -r)
VOLATILITY_SYMBOLS_DIR="$HOME/.local/share/volatility3/symbols"
mkdir -p "$VOLATILITY_SYMBOLS_DIR/linux"

# Generate symbols for the current kernel (for live system analysis)
# Using dwarf2json
git clone https://github.com/volatilityfoundation/dwarf2json
cd dwarf2json
go build .
./dwarf2json linux --elf /usr/lib/debug/boot/vmlinux-$(uname -r) \
  > "$VOLATILITY_SYMBOLS_DIR/linux/${KERNEL_VERSION}.json"

# Compress for efficiency
gzip "$VOLATILITY_SYMBOLS_DIR/linux/${KERNEL_VERSION}.json"
```

### Creating a Memory Image

```bash
# Using LiME (Linux Memory Extractor) — kernel module approach
# This is the most forensically sound method

# Install LiME
git clone https://github.com/504ensicsLabs/LiME
cd LiME/src
make

# Load the module to dump memory to a file
# CRITICAL: This must be to a DIFFERENT disk/network to avoid modifying evidence
sudo insmod lime-$(uname -r).ko \
  "path=/mnt/external_drive/memory.lime format=lime"

# Alternatively, dump over network (avoids disk write)
sudo insmod lime-$(uname -r).ko \
  "path=tcp:4444 format=lime"

# On the analysis machine:
nc -l 4444 > /tmp/memory.lime

# Unload when done
sudo rmmod lime
```

### Volatility3 Analysis Workflow

```bash
# Verify the memory image is valid
vol3 -f /tmp/memory.lime banners.Banners

# List running processes (pstree equivalent)
vol3 -f /tmp/memory.lime linux.pslist.PsList
vol3 -f /tmp/memory.lime linux.pstree.PsTree

# Show process tree including zombie/hidden processes
vol3 -f /tmp/memory.lime linux.psaux.PsAux

# List network connections
vol3 -f /tmp/memory.lime linux.netstat.Netstat

# Show loaded kernel modules
vol3 -f /tmp/memory.lime linux.lsmod.Lsmod

# Detect hidden kernel modules (rootkit detection)
vol3 -f /tmp/memory.lime linux.check_modules.Check_modules

# Show system calls (detect syscall hooking)
vol3 -f /tmp/memory.lime linux.check_syscall.Check_syscall

# Analyze a specific process
vol3 -f /tmp/memory.lime linux.proc_maps.ProcMaps --pid 1234

# Dump executable regions of a suspicious process
vol3 -f /tmp/memory.lime linux.proc_maps.ProcMaps --pid 1234 --dump

# Find strings in process memory
vol3 -f /tmp/memory.lime linux.strings.Strings --pid 1234 \
  | grep -i "password\|token\|credentials"

# Check for LD_PRELOAD injection (common malware technique)
vol3 -f /tmp/memory.lime linux.envars.Envars \
  | grep -i "ld_preload\|ld_library"
```

### Detecting Process Injection

```bash
# List anonymous executable memory regions across all processes
# This is the primary indicator of code injection / shellcode
vol3 -f /tmp/memory.lime linux.proc_maps.ProcMaps \
  | awk '($4 == "rwx" || $4 == "r-x") && $6 == "" {
    printf "PID=%s ADDR=%s-%s PERMS=%s\n", $1, $2, $3, $4
  }'

# More thorough: find all RWX mappings (classic shellcode staging)
vol3 -f /tmp/memory.lime linux.proc_maps.ProcMaps \
  | grep "rwx"

# Cross-reference with expected executable regions for known binaries
vol3 -f /tmp/memory.lime linux.proc_maps.ProcMaps --pid $SUSPICIOUS_PID
```

## Section 6: Container Memory Forensics

Container environments require adaptations because containers share the host kernel.

### Finding Container Processes

```bash
# Map container IDs to PIDs
docker ps -q | while read CONTAINER_ID; do
    PID=$(docker inspect --format '{{.State.Pid}}' $CONTAINER_ID)
    NAME=$(docker inspect --format '{{.Name}}' $CONTAINER_ID)
    echo "Container: $NAME  PID: $PID  CID: $CONTAINER_ID"
done

# Kubernetes pod to PID mapping
kubectl get pods -A -o wide | grep <node-name>
crictl ps | grep <pod-name>
# Get the container PID
CONTAINER_ID=$(crictl ps | grep <container-name> | awk '{print $1}')
crictl inspect $CONTAINER_ID | jq '.info.pid'
```

### Container Memory Dump

```bash
# Enter container namespace for memory analysis
CONTAINER_PID=$(crictl inspect $CONTAINER_ID | jq '.info.pid')

# Read container memory from host perspective (same PID namespace)
nsenter -t $CONTAINER_PID -m -u -p -- /bin/bash <<'EOF'
# Now we're in the container's mount/PID namespace
ps aux
cat /proc/self/maps
EOF

# Dump container process memory (from host, no namespace entry needed)
# Container processes appear in the host /proc like regular processes
cat /proc/$CONTAINER_PID/maps
dd if=/proc/$CONTAINER_PID/mem ...

# Use gcore to dump container process
gcore -o /tmp/container_dump $CONTAINER_PID
```

### Detecting Secrets in Container Memory

```bash
#!/bin/bash
# find_secrets_in_containers.sh

scan_container_memory() {
    local pid=$1
    local container_name=$2

    echo "Scanning container: $container_name (PID: $pid)"

    # Patterns to search for in memory
    local patterns=(
        "password"
        "passwd"
        "secret"
        "token"
        "api_key"
        "private_key"
        "BEGIN.*PRIVATE"
        "aws_access_key"
        "AKIA[A-Z0-9]{16}"  # AWS key pattern
    )

    # Read heap region
    local heap_start heap_end
    while IFS= read -r line; do
        if echo "$line" | grep -q "^\w.*\[heap\]"; then
            heap_start=$(echo "$line" | awk '{print $1}' | cut -d- -f1)
            heap_end=$(echo "$line" | awk '{print $1}' | cut -d- -f2)
            break
        fi
    done < /proc/$pid/maps

    if [ -z "$heap_start" ]; then
        return
    fi

    start_dec=$((16#$heap_start))
    end_dec=$((16#$heap_end))
    size=$((end_dec - start_dec))

    # Read and scan heap
    dd if=/proc/$pid/mem bs=1 skip=$start_dec count=$size of=/tmp/heap_$pid.bin 2>/dev/null

    for pattern in "${patterns[@]}"; do
        if strings /tmp/heap_$pid.bin 2>/dev/null | grep -qi "$pattern"; then
            echo "  ALERT: Found potential secret matching pattern: $pattern"
        fi
    done

    rm -f /tmp/heap_$pid.bin
}

# Scan all container processes
docker ps -q | while read CONTAINER_ID; do
    PID=$(docker inspect --format '{{.State.Pid}}' $CONTAINER_ID)
    NAME=$(docker inspect --format '{{.Name}}' $CONTAINER_ID)
    scan_container_memory "$PID" "$NAME"
done
```

## Section 7: Analyzing the Kernel with /proc/kcore

`/proc/kcore` provides access to kernel memory in ELF core format:

```bash
# WARNING: /proc/kcore is kernel memory — handle with extreme care

# Check size (represents entire physical RAM)
ls -lh /proc/kcore

# Use gdb to read kernel memory
sudo gdb /usr/lib/debug/vmlinux-$(uname -r) /proc/kcore

# In gdb:
(gdb) p init_task.comm  # Print the init process name
(gdb) p &(init_task.tasks)  # Get task list head
(gdb) x/s jiffies  # Read jiffies counter

# Find kernel modules
sudo python3 -c "
import struct
with open('/proc/modules') as f:
    for line in f:
        parts = line.split()
        print(f'Module: {parts[0]}, Size: {parts[1]}, Used: {parts[2]}')
"

# Detect potential rootkits via direct kernel scan
sudo strings /proc/kcore 2>/dev/null | grep -E "rootkit|backdoor|hid_" | head -20
```

## Section 8: Timeline and Evidence Preservation

```bash
#!/bin/bash
# ir_memory_collection.sh — Incident Response Memory Collection Script
# Follows forensic evidence preservation principles

CASE_ID=$1
EVIDENCE_DIR="/mnt/evidence/${CASE_ID}"
mkdir -p "$EVIDENCE_DIR"

TIMESTAMP=$(date -u +%Y%m%d_%H%M%S)
LOG_FILE="$EVIDENCE_DIR/collection_log_${TIMESTAMP}.txt"

log() {
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG_FILE"
}

# Calculate hash before and after to ensure integrity
collect_proc_file() {
    local pid=$1
    local file=$2
    local dest=$3

    cp "/proc/$pid/$file" "$dest" 2>/dev/null
    if [ -f "$dest" ]; then
        sha256sum "$dest" >> "$EVIDENCE_DIR/hashes.txt"
        log "Collected /proc/$pid/$file -> $dest"
    fi
}

# Collect volatile data first (order matters!)
log "Starting memory evidence collection for case $CASE_ID"
log "Hostname: $(hostname), Kernel: $(uname -r)"

# System-wide volatile state
log "Collecting system state..."
date -u > "$EVIDENCE_DIR/timestamp.txt"
cat /proc/uptime >> "$EVIDENCE_DIR/timestamp.txt"
ps auxwwf > "$EVIDENCE_DIR/process_list.txt"
netstat -antp > "$EVIDENCE_DIR/network_connections.txt" 2>/dev/null || ss -antp > "$EVIDENCE_DIR/network_connections.txt"
lsof -n > "$EVIDENCE_DIR/open_files.txt" 2>/dev/null
cat /proc/net/tcp > "$EVIDENCE_DIR/kernel_tcp.txt"
cat /proc/net/tcp6 >> "$EVIDENCE_DIR/kernel_tcp.txt"
lsmod > "$EVIDENCE_DIR/kernel_modules.txt"
cat /proc/sys/kernel/hostname > "$EVIDENCE_DIR/hostname.txt"
last -50 > "$EVIDENCE_DIR/last_logins.txt"
who > "$EVIDENCE_DIR/current_logins.txt"
w > "$EVIDENCE_DIR/current_activity.txt"
history > "$EVIDENCE_DIR/bash_history.txt" 2>/dev/null
cat /var/log/auth.log > "$EVIDENCE_DIR/auth.log" 2>/dev/null

# Collect memory for suspicious processes
for PID in $(ps aux | grep -v grep | awk '{if ($3>10 || $4>10) print $2}'); do
    PID_DIR="$EVIDENCE_DIR/proc_${PID}"
    mkdir -p "$PID_DIR"

    for f in maps smaps status cmdline environ; do
        collect_proc_file "$PID" "$f" "$PID_DIR/$f"
    done

    # Get the executable
    readlink -f "/proc/$PID/exe" > "$PID_DIR/exe_path.txt" 2>/dev/null
done

# Full memory image
log "Creating full memory image..."
if command -v insmod &>/dev/null && [ -f "/lib/modules/$(uname -r)/lime.ko" ]; then
    insmod "/lib/modules/$(uname -r)/lime.ko" \
        "path=$EVIDENCE_DIR/memory_${TIMESTAMP}.lime format=lime"
    sleep 5
    rmmod lime
    sha256sum "$EVIDENCE_DIR/memory_${TIMESTAMP}.lime" >> "$EVIDENCE_DIR/hashes.txt"
    log "Memory image created: memory_${TIMESTAMP}.lime"
else
    log "LiME not available — skipping full memory image"
fi

# Final hash of entire evidence directory
log "Computing evidence directory hash..."
find "$EVIDENCE_DIR" -type f | sort | xargs sha256sum > "$EVIDENCE_DIR/all_hashes.txt"
sha256sum "$EVIDENCE_DIR/all_hashes.txt"

log "Collection complete. Evidence stored in $EVIDENCE_DIR"
```

## Summary

Linux memory forensics provides visibility that disk forensics and log analysis cannot — it reveals what is actually executing in memory at the time of investigation. Key techniques:

- `/proc/PID/mem` with ptrace attachment gives direct byte-level access to process memory; suitable for live forensics
- `/proc/PID/smaps` reveals memory layout, anonymous regions (heap/stack), and shared library usage; anonymous executable regions are the primary indicator of code injection
- `gcore` creates a forensically sound process dump without killing the process
- Volatility3 with ISF symbol tables enables deep analysis of full system memory images including kernel structures, hidden processes, and syscall hook detection
- Container forensics works through the host's `/proc` since containers share the kernel; container PID mapping is the first step
- `/proc/kcore` exposes kernel memory for advanced rootkit detection
- Evidence preservation requires capturing volatile data in order: running processes first, then network state, then memory image

The forensics toolkit presented here covers both live incident response (where speed matters) and post-incident analysis (where thoroughness and evidence integrity matter). Combining both approaches — quickly triaging via `/proc` then preserving with LiME — represents the operational best practice.
