---
title: "Container Memory Dump Analysis for Forensics: Enterprise Investigation Guide"
date: 2026-05-21T00:00:00-05:00
draft: false
tags: ["Containers", "Memory Forensics", "Incident Response", "Security", "Kubernetes", "Docker", "Enterprise"]
categories: ["Security", "DevOps", "Kubernetes"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to container memory dump analysis for forensic investigation, including memory capture techniques, artifact extraction, and malware detection in containerized environments."
more_link: "yes"
url: "/container-memory-dump-analysis-forensics-guide/"
---

Master container memory dump analysis for forensic investigations with comprehensive techniques for capturing, analyzing, and extracting artifacts from container memory in enterprise Kubernetes and Docker environments.

<!--more-->

# Container Memory Dump Analysis for Forensics: Enterprise Investigation Guide

## Executive Summary

Memory forensics in containerized environments presents unique challenges due to the ephemeral nature of containers, shared kernel space, and namespace isolation. This comprehensive guide covers enterprise-grade techniques for capturing and analyzing container memory dumps, extracting security artifacts, detecting malware, and reconstructing attack timelines. We'll explore production-tested tools, automated analysis workflows, and best practices for container memory forensics in Kubernetes and Docker environments.

## Understanding Container Memory Architecture

### Container Memory Layout

Containers share the host kernel but have isolated memory spaces through cgroups and namespaces:

```
┌─────────────────────────────────────────┐
│         Host Physical Memory            │
├─────────────────────────────────────────┤
│          Host Kernel Space              │
│  (Shared by all containers)             │
├─────────────────────────────────────────┤
│     Container 1 Memory Cgroup           │
│  ┌──────────────────────────────────┐   │
│  │  Process Memory Space            │   │
│  │  - Code (.text)                  │   │
│  │  - Data (.data, .bss)            │   │
│  │  - Heap                          │   │
│  │  - Memory-mapped files           │   │
│  │  - Stack(s)                      │   │
│  └──────────────────────────────────┘   │
├─────────────────────────────────────────┤
│     Container 2 Memory Cgroup           │
│  ┌──────────────────────────────────┐   │
│  │  Process Memory Space            │   │
│  │  ...                             │   │
│  └──────────────────────────────────┘   │
└─────────────────────────────────────────┘
```

### Key Memory Artifacts in Containers

Important artifacts available in container memory:

1. **Process Memory**
   - Running binaries and libraries
   - Application data structures
   - Configuration and credentials
   - Network connection state

2. **File Cache**
   - Recently accessed files
   - Deleted files still in cache
   - Temporary files

3. **Network Buffers**
   - Active connections
   - Recent network traffic
   - SSL/TLS session keys

4. **Kernel Structures**
   - Process lists
   - Open file descriptors
   - Network sockets
   - Loaded kernel modules

## Memory Capture Techniques

### Live Container Memory Capture

Capture memory from a running container using multiple methods:

```bash
#!/bin/bash
# capture-container-memory.sh - Comprehensive container memory capture

set -euo pipefail

CONTAINER_ID="${1:-}"
OUTPUT_DIR="${2:-./memory-capture-$(date +%Y%m%d-%H%M%S)}"

if [[ -z "${CONTAINER_ID}" ]]; then
    echo "Usage: $0 <container-id> [output-dir]"
    exit 1
fi

mkdir -p "${OUTPUT_DIR}"

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" | tee -a "${OUTPUT_DIR}/capture.log"
}

log "Starting memory capture for container: ${CONTAINER_ID}"

# Determine container runtime
if command -v docker &> /dev/null && docker inspect "${CONTAINER_ID}" &> /dev/null; then
    RUNTIME="docker"
    RUNTIME_CMD="docker"
elif command -v podman &> /dev/null && podman inspect "${CONTAINER_ID}" &> /dev/null; then
    RUNTIME="podman"
    RUNTIME_CMD="podman"
elif command -v crictl &> /dev/null && crictl inspect "${CONTAINER_ID}" &> /dev/null; then
    RUNTIME="containerd"
    RUNTIME_CMD="crictl"
else
    log "ERROR: Could not determine container runtime or container not found"
    exit 1
fi

log "Container runtime: ${RUNTIME}"

# Get container information
log "Collecting container metadata..."
${RUNTIME_CMD} inspect "${CONTAINER_ID}" > "${OUTPUT_DIR}/container-inspect.json"

# Get container PID
if [[ "${RUNTIME}" == "docker" || "${RUNTIME}" == "podman" ]]; then
    CONTAINER_PID=$(${RUNTIME_CMD} inspect --format '{{.State.Pid}}' "${CONTAINER_ID}")
elif [[ "${RUNTIME}" == "containerd" ]]; then
    CONTAINER_PID=$(crictl inspect "${CONTAINER_ID}" | jq -r '.info.pid')
fi

log "Container main PID: ${CONTAINER_PID}"

# Get all PIDs in container namespace
log "Identifying all processes in container..."
CONTAINER_PIDS=$(nsenter -t "${CONTAINER_PID}" -p ps -eo pid --no-headers | tr '\n' ' ')
echo "${CONTAINER_PIDS}" > "${OUTPUT_DIR}/container-pids.txt"
log "Container PIDs: ${CONTAINER_PIDS}"

# METHOD 1: Use gcore to dump process memory
log "METHOD 1: Capturing process memory with gcore..."
mkdir -p "${OUTPUT_DIR}/gcore"

for pid in ${CONTAINER_PIDS}; do
    log "  Dumping memory for PID ${pid}..."
    gcore -o "${OUTPUT_DIR}/gcore/core" "${pid}" 2>&1 | tee -a "${OUTPUT_DIR}/capture.log" || true
done

# METHOD 2: Copy process memory maps directly
log "METHOD 2: Copying process memory maps from /proc..."
mkdir -p "${OUTPUT_DIR}/proc-mem"

for pid in ${CONTAINER_PIDS}; do
    log "  Capturing /proc/${pid}/mem..."

    # Save memory maps
    cp "/proc/${pid}/maps" "${OUTPUT_DIR}/proc-mem/pid-${pid}-maps.txt" 2>/dev/null || true
    cp "/proc/${pid}/status" "${OUTPUT_DIR}/proc-mem/pid-${pid}-status.txt" 2>/dev/null || true
    cp "/proc/${pid}/cmdline" "${OUTPUT_DIR}/proc-mem/pid-${pid}-cmdline.txt" 2>/dev/null || true
    cp "/proc/${pid}/environ" "${OUTPUT_DIR}/proc-mem/pid-${pid}-environ.txt" 2>/dev/null || true

    # Dump memory segments
    if [[ -r "/proc/${pid}/mem" ]]; then
        mkdir -p "${OUTPUT_DIR}/proc-mem/pid-${pid}"

        # Parse memory maps and dump each segment
        while IFS= read -r line; do
            # Extract address range and permissions
            addr_range=$(echo "$line" | awk '{print $1}')
            perms=$(echo "$line" | awk '{print $2}')
            path=$(echo "$line" | awk '{print $6}')

            # Skip non-readable segments
            [[ "$perms" =~ r ]] || continue

            start_addr="0x${addr_range%-*}"
            end_addr="0x${addr_range#*-}"

            # Calculate size
            size=$((end_addr - start_addr))

            # Skip if too large (> 100MB)
            if [[ $size -gt 104857600 ]]; then
                log "    Skipping large segment: ${addr_range} (${size} bytes)"
                continue
            fi

            segment_name=$(echo "${addr_range}_${path##*/}" | tr '/' '_')
            log "    Dumping segment: ${addr_range} (${size} bytes)"

            dd if="/proc/${pid}/mem" of="${OUTPUT_DIR}/proc-mem/pid-${pid}/${segment_name}.bin" \
                bs=1 skip=$((start_addr)) count=$size 2>/dev/null || true

        done < "/proc/${pid}/maps"
    fi
done

# METHOD 3: Use container checkpoint (if supported)
log "METHOD 3: Creating container checkpoint..."
if [[ "${RUNTIME}" == "docker" ]]; then
    # Experimental feature in Docker
    docker checkpoint create "${CONTAINER_ID}" "forensics-checkpoint-$(date +%s)" \
        --checkpoint-dir="${OUTPUT_DIR}/checkpoint" 2>&1 | tee -a "${OUTPUT_DIR}/capture.log" || \
        log "  Docker checkpoint not available (experimental feature)"
elif [[ "${RUNTIME}" == "podman" ]]; then
    podman container checkpoint "${CONTAINER_ID}" \
        --export="${OUTPUT_DIR}/checkpoint/checkpoint.tar.gz" 2>&1 | tee -a "${OUTPUT_DIR}/capture.log" || \
        log "  Podman checkpoint failed"
fi

# METHOD 4: Capture container filesystem (includes memory-mapped files)
log "METHOD 4: Capturing container filesystem..."
mkdir -p "${OUTPUT_DIR}/filesystem"

${RUNTIME_CMD} export "${CONTAINER_ID}" | tar -C "${OUTPUT_DIR}/filesystem" -xf - 2>&1 | tee -a "${OUTPUT_DIR}/capture.log" || true

# Collect additional context
log "Collecting additional context..."

# Network connections
nsenter -t "${CONTAINER_PID}" -n netstat -tunap > "${OUTPUT_DIR}/network-connections.txt" 2>&1 || true

# Open files
for pid in ${CONTAINER_PIDS}; do
    lsof -p "${pid}" > "${OUTPUT_DIR}/open-files-${pid}.txt" 2>&1 || true
done

# Process tree
nsenter -t "${CONTAINER_PID}" -p ps auxwwf > "${OUTPUT_DIR}/process-tree.txt" 2>&1 || true

# Environment variables (sanitized)
for pid in ${CONTAINER_PIDS}; do
    cat "/proc/${pid}/environ" | tr '\0' '\n' > "${OUTPUT_DIR}/environment-${pid}.txt" 2>&1 || true
done

# Calculate checksums
log "Calculating checksums..."
find "${OUTPUT_DIR}" -type f -exec sha256sum {} \; > "${OUTPUT_DIR}/checksums.txt"

# Create metadata file
cat > "${OUTPUT_DIR}/METADATA.txt" << EOF
Container Memory Capture Metadata
==================================

Capture Date: $(date --iso-8601=seconds)
Capture Host: $(hostname)
Capturer: $(whoami)

Container Information:
- Container ID: ${CONTAINER_ID}
- Runtime: ${RUNTIME}
- Main PID: ${CONTAINER_PID}
- All PIDs: ${CONTAINER_PIDS}

Container Details:
$(${RUNTIME_CMD} inspect "${CONTAINER_ID}" --format '- Image: {{.Config.Image}}
- Status: {{.State.Status}}
- Started: {{.State.StartedAt}}
- Name: {{.Name}}')

Capture Methods Used:
- gcore dumps: $(ls -1 ${OUTPUT_DIR}/gcore/*.core.* 2>/dev/null | wc -l) files
- /proc/mem dumps: $(find ${OUTPUT_DIR}/proc-mem -name "*.bin" 2>/dev/null | wc -l) segments
- Checkpoint: $(if [[ -d ${OUTPUT_DIR}/checkpoint ]]; then echo "Yes"; else echo "No"; fi)
- Filesystem: $(if [[ -d ${OUTPUT_DIR}/filesystem ]]; then echo "Yes"; else echo "No"; fi)

Total Capture Size: $(du -sh "${OUTPUT_DIR}" | cut -f1)

EOF

cat "${OUTPUT_DIR}/METADATA.txt"

# Compress capture
log "Compressing memory capture..."
tar -czf "${OUTPUT_DIR}.tar.gz" "${OUTPUT_DIR}"
sha256sum "${OUTPUT_DIR}.tar.gz" > "${OUTPUT_DIR}.tar.gz.sha256"

log "Memory capture complete!"
log "Output directory: ${OUTPUT_DIR}"
log "Compressed archive: ${OUTPUT_DIR}.tar.gz"
log "Archive checksum: $(cat ${OUTPUT_DIR}.tar.gz.sha256)"
```

### Kubernetes Pod Memory Capture

Capture memory from Kubernetes pods with proper orchestration:

```bash
#!/bin/bash
# k8s-pod-memory-capture.sh - Kubernetes pod memory capture

set -euo pipefail

POD_NAME="${1:-}"
NAMESPACE="${2:-default}"
CONTAINER_NAME="${3:-}"
OUTPUT_DIR="./k8s-memory-${POD_NAME}-$(date +%Y%m%d-%H%M%S)"

if [[ -z "${POD_NAME}" ]]; then
    echo "Usage: $0 <pod-name> [namespace] [container-name]"
    exit 1
fi

mkdir -p "${OUTPUT_DIR}"

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" | tee -a "${OUTPUT_DIR}/capture.log"
}

log "Capturing memory from pod ${NAMESPACE}/${POD_NAME}"

# Get pod information
kubectl get pod -n "${NAMESPACE}" "${POD_NAME}" -o yaml > "${OUTPUT_DIR}/pod-spec.yaml"

# Get node name
NODE=$(kubectl get pod -n "${NAMESPACE}" "${POD_NAME}" -o jsonpath='{.spec.nodeName}')
log "Pod is running on node: ${NODE}"

# If container not specified, get first container
if [[ -z "${CONTAINER_NAME}" ]]; then
    CONTAINER_NAME=$(kubectl get pod -n "${NAMESPACE}" "${POD_NAME}" -o jsonpath='{.spec.containers[0].name}')
fi

log "Target container: ${CONTAINER_NAME}"

# Get container ID
CONTAINER_ID=$(kubectl get pod -n "${NAMESPACE}" "${POD_NAME}" -o jsonpath="{.status.containerStatuses[?(@.name=='${CONTAINER_NAME}')].containerID}" | sed 's/.*:\/\///')
log "Container ID: ${CONTAINER_ID}"

# Deploy forensics daemonset on the target node
log "Deploying forensics pod on node ${NODE}..."

cat > "${OUTPUT_DIR}/forensics-pod.yaml" << EOF
apiVersion: v1
kind: Pod
metadata:
  name: forensics-${POD_NAME}-$(date +%s)
  namespace: ${NAMESPACE}
  labels:
    app: forensics
    target-pod: ${POD_NAME}
spec:
  nodeName: ${NODE}
  hostPID: true
  hostNetwork: true
  containers:
  - name: forensics
    image: nicolaka/netshoot:latest
    command: ['sleep', 'infinity']
    securityContext:
      privileged: true
      capabilities:
        add:
        - SYS_ADMIN
        - SYS_PTRACE
    volumeMounts:
    - name: host-root
      mountPath: /host
    - name: container-runtime
      mountPath: /run/containerd
    - name: captures
      mountPath: /captures
  volumes:
  - name: host-root
    hostPath:
      path: /
  - name: container-runtime
    hostPath:
      path: /run/containerd
  - name: captures
    emptyDir: {}
  restartPolicy: Never
EOF

FORENSICS_POD=$(kubectl apply -f "${OUTPUT_DIR}/forensics-pod.yaml" -o jsonpath='{.metadata.name}')
log "Forensics pod created: ${FORENSICS_POD}"

# Wait for pod to be ready
log "Waiting for forensics pod to be ready..."
kubectl wait --for=condition=Ready pod -n "${NAMESPACE}" "${FORENSICS_POD}" --timeout=60s

# Execute memory capture from forensics pod
log "Executing memory capture..."

# Get container PID
CONTAINER_PID=$(kubectl exec -n "${NAMESPACE}" "${FORENSICS_POD}" -- \
    chroot /host crictl inspect "${CONTAINER_ID}" 2>/dev/null | jq -r '.info.pid' || \
    kubectl exec -n "${NAMESPACE}" "${FORENSICS_POD}" -- \
    chroot /host docker inspect --format '{{.State.Pid}}' "${CONTAINER_ID}" 2>/dev/null)

log "Container PID: ${CONTAINER_PID}"

# Capture memory using gcore
kubectl exec -n "${NAMESPACE}" "${FORENSICS_POD}" -- bash -c "
    cd /captures
    gcore -o core ${CONTAINER_PID}
" 2>&1 | tee -a "${OUTPUT_DIR}/capture.log"

# Copy memory dump from forensics pod
log "Retrieving memory dump..."
kubectl cp "${NAMESPACE}/${FORENSICS_POD}:/captures/" "${OUTPUT_DIR}/dumps/"

# Capture additional process information
kubectl exec -n "${NAMESPACE}" "${FORENSICS_POD}" -- bash -c "
    cp /host/proc/${CONTAINER_PID}/maps /captures/maps.txt
    cp /host/proc/${CONTAINER_PID}/status /captures/status.txt
    cp /host/proc/${CONTAINER_PID}/cmdline /captures/cmdline.txt
    cp /host/proc/${CONTAINER_PID}/environ /captures/environ.txt
    ps -p ${CONTAINER_PID} -o pid,ppid,cmd,%mem,%cpu > /captures/process-info.txt
" 2>&1 | tee -a "${OUTPUT_DIR}/capture.log"

kubectl cp "${NAMESPACE}/${FORENSICS_POD}:/captures/" "${OUTPUT_DIR}/process-info/"

# Cleanup forensics pod
log "Cleaning up forensics pod..."
kubectl delete pod -n "${NAMESPACE}" "${FORENSICS_POD}"

# Calculate checksums
find "${OUTPUT_DIR}" -type f -exec sha256sum {} \; > "${OUTPUT_DIR}/checksums.txt"

log "Kubernetes pod memory capture complete!"
log "Output directory: ${OUTPUT_DIR}"
```

## Memory Dump Analysis

### Automated Memory Analysis Framework

Create a comprehensive memory analysis framework:

```python
#!/usr/bin/env python3
# container-memory-analyzer.py - Container memory forensics analyzer

import os
import sys
import re
import subprocess
import json
from pathlib import Path
from typing import List, Dict, Set
import struct

class ContainerMemoryAnalyzer:
    def __init__(self, memory_dump_path: str, output_dir: str):
        self.memory_dump = Path(memory_dump_path)
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(exist_ok=True)

        self.findings = {
            'credentials': [],
            'network_artifacts': [],
            'malware_indicators': [],
            'suspicious_strings': [],
            'crypto_keys': [],
            'file_artifacts': []
        }

    def analyze(self):
        """Run all analysis modules"""
        print(f"Analyzing memory dump: {self.memory_dump}")

        if self.memory_dump.suffix == '.core' or 'core.' in self.memory_dump.name:
            self.analyze_core_dump()
        else:
            self.analyze_raw_memory()

        self.search_credentials()
        self.search_network_artifacts()
        self.search_crypto_material()
        self.search_file_artifacts()
        self.search_suspicious_patterns()

        self.generate_report()

    def analyze_core_dump(self):
        """Analyze ELF core dump using various tools"""
        print("Analyzing ELF core dump...")

        # Use GDB to extract information
        gdb_script = self.output_dir / "gdb-script.txt"
        with open(gdb_script, 'w') as f:
            f.write("""
info proc mappings
info threads
info sharedlibrary
x/1000s $sp
quit
""")

        try:
            result = subprocess.run(
                ['gdb', '-batch', '-x', str(gdb_script), str(self.memory_dump)],
                capture_output=True,
                text=True,
                timeout=300
            )
            with open(self.output_dir / "gdb-output.txt", 'w') as f:
                f.write(result.stdout)
        except Exception as e:
            print(f"GDB analysis failed: {e}")

        # Extract strings
        self._extract_strings()

    def analyze_raw_memory(self):
        """Analyze raw memory segments"""
        print("Analyzing raw memory segments...")

        if self.memory_dump.is_dir():
            # Multiple memory segments
            for mem_file in self.memory_dump.glob("*.bin"):
                self._analyze_memory_segment(mem_file)
        else:
            # Single memory file
            self._analyze_memory_segment(self.memory_dump)

    def _analyze_memory_segment(self, mem_file: Path):
        """Analyze individual memory segment"""
        print(f"  Analyzing segment: {mem_file.name}")

        # Extract strings
        strings_file = self.output_dir / f"strings_{mem_file.stem}.txt"
        try:
            subprocess.run(
                ['strings', '-n', '6', str(mem_file)],
                stdout=open(strings_file, 'w'),
                timeout=60
            )
        except Exception as e:
            print(f"    String extraction failed: {e}")

    def _extract_strings(self):
        """Extract strings from memory dump"""
        print("Extracting strings...")

        strings_file = self.output_dir / "all_strings.txt"

        try:
            subprocess.run(
                ['strings', '-a', '-n', '6', str(self.memory_dump)],
                stdout=open(strings_file, 'w'),
                timeout=300
            )
        except Exception as e:
            print(f"String extraction failed: {e}")

    def search_credentials(self):
        """Search for credentials in memory"""
        print("Searching for credentials...")

        patterns = {
            'password': [
                rb'password["\s:=]+([^\s"\']+)',
                rb'PASSWORD["\s:=]+([^\s"\']+)',
                rb'pwd["\s:=]+([^\s"\']+)',
            ],
            'api_key': [
                rb'api[_-]?key["\s:=]+([A-Za-z0-9_\-]+)',
                rb'API[_-]?KEY["\s:=]+([A-Za-z0-9_\-]+)',
            ],
            'token': [
                rb'token["\s:=]+([A-Za-z0-9_\-\.]+)',
                rb'TOKEN["\s:=]+([A-Za-z0-9_\-\.]+)',
                rb'jwt["\s:=]+([A-Za-z0-9_\-\.]+)',
            ],
            'private_key': [
                rb'-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----.*?-----END (?:RSA |EC |DSA )?PRIVATE KEY-----',
            ],
            'aws_key': [
                rb'AKIA[0-9A-Z]{16}',
                rb'aws[_-]?secret[_-]?access[_-]?key["\s:=]+([A-Za-z0-9/+=]+)',
            ],
            'connection_string': [
                rb'(?:mysql|postgres|mongodb|redis)://[^\s"\']+',
            ]
        }

        # Search in strings file
        strings_files = list(self.output_dir.glob("strings_*.txt")) + \
                       list(self.output_dir.glob("all_strings.txt"))

        for strings_file in strings_files:
            if not strings_file.exists():
                continue

            with open(strings_file, 'rb') as f:
                content = f.read()

                for cred_type, pattern_list in patterns.items():
                    for pattern in pattern_list:
                        matches = re.finditer(pattern, content, re.IGNORECASE | re.DOTALL)
                        for match in matches:
                            self.findings['credentials'].append({
                                'type': cred_type,
                                'value': match.group(0).decode('utf-8', errors='ignore')[:200],
                                'source': strings_file.name
                            })

        print(f"  Found {len(self.findings['credentials'])} potential credentials")

    def search_network_artifacts(self):
        """Search for network-related artifacts"""
        print("Searching for network artifacts...")

        patterns = {
            'ip_address': rb'\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b',
            'domain': rb'(?:[a-zA-Z0-9](?:[a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}',
            'url': rb'https?://[^\s"\'<>]+',
            'email': rb'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b',
        }

        strings_files = list(self.output_dir.glob("strings_*.txt")) + \
                       list(self.output_dir.glob("all_strings.txt"))

        unique_artifacts = {k: set() for k in patterns.keys()}

        for strings_file in strings_files:
            if not strings_file.exists():
                continue

            with open(strings_file, 'rb') as f:
                content = f.read()

                for artifact_type, pattern in patterns.items():
                    matches = re.finditer(pattern, content)
                    for match in matches:
                        artifact = match.group(0).decode('utf-8', errors='ignore')
                        unique_artifacts[artifact_type].add(artifact)

        # Store findings
        for artifact_type, artifacts in unique_artifacts.items():
            for artifact in artifacts:
                self.findings['network_artifacts'].append({
                    'type': artifact_type,
                    'value': artifact
                })

        print(f"  Found {len(self.findings['network_artifacts'])} network artifacts")

    def search_crypto_material(self):
        """Search for cryptographic keys and certificates"""
        print("Searching for cryptographic material...")

        patterns = {
            'private_key': rb'-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----.*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----',
            'certificate': rb'-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----',
            'ssh_key': rb'ssh-(?:rsa|dss|ed25519) [A-Za-z0-9+/]+=*',
        }

        strings_files = list(self.output_dir.glob("strings_*.txt")) + \
                       list(self.output_dir.glob("all_strings.txt"))

        for strings_file in strings_files:
            if not strings_file.exists():
                continue

            with open(strings_file, 'rb') as f:
                content = f.read()

                for key_type, pattern in patterns.items():
                    matches = re.finditer(pattern, content, re.DOTALL)
                    for match in matches:
                        self.findings['crypto_keys'].append({
                            'type': key_type,
                            'value': match.group(0).decode('utf-8', errors='ignore')[:500],
                            'source': strings_file.name
                        })

        print(f"  Found {len(self.findings['crypto_keys'])} cryptographic artifacts")

    def search_file_artifacts(self):
        """Search for file paths and names"""
        print("Searching for file artifacts...")

        patterns = [
            rb'/(?:usr|etc|var|opt|home|root)/[^\s"\'<>]+',
            rb'[A-Z]:\\[^\s"\'<>]+',
        ]

        strings_files = list(self.output_dir.glob("strings_*.txt")) + \
                       list(self.output_dir.glob("all_strings.txt"))

        unique_paths = set()

        for strings_file in strings_files:
            if not strings_file.exists():
                continue

            with open(strings_file, 'rb') as f:
                content = f.read()

                for pattern in patterns:
                    matches = re.finditer(pattern, content)
                    for match in matches:
                        path = match.group(0).decode('utf-8', errors='ignore')
                        unique_paths.add(path)

        for path in unique_paths:
            self.findings['file_artifacts'].append({
                'type': 'path',
                'value': path
            })

        print(f"  Found {len(self.findings['file_artifacts'])} file artifacts")

    def search_suspicious_patterns(self):
        """Search for suspicious patterns indicating malware or attacks"""
        print("Searching for suspicious patterns...")

        suspicious_patterns = {
            'reverse_shell': [
                rb'/bin/(?:ba)?sh -i',
                rb'nc -[el]',
                rb'python.*socket\.connect',
                rb'perl.*socket',
            ],
            'crypto_miner': [
                rb'xmrig',
                rb'minerd',
                rb'cpuminer',
                rb'stratum\+tcp://',
                rb'cryptonight',
            ],
            'persistence': [
                rb'crontab -e',
                rb'\.bashrc',
                rb'\.profile',
                rb'/etc/rc\.local',
                rb'systemd.*service',
            ],
            'privilege_escalation': [
                rb'sudo su',
                rb'chmod \+s',
                rb'setuid',
                rb'/etc/sudoers',
            ],
            'data_exfiltration': [
                rb'curl.*-d',
                rb'wget.*--post',
                rb'base64 -[de]',
                rb'tar.*czf.*-\s*\|',
            ]
        }

        strings_files = list(self.output_dir.glob("strings_*.txt")) + \
                       list(self.output_dir.glob("all_strings.txt"))

        for strings_file in strings_files:
            if not strings_file.exists():
                continue

            with open(strings_file, 'rb') as f:
                content = f.read()

                for indicator_type, pattern_list in suspicious_patterns.items():
                    for pattern in pattern_list:
                        matches = re.finditer(pattern, content, re.IGNORECASE)
                        for match in matches:
                            self.findings['suspicious_strings'].append({
                                'type': indicator_type,
                                'value': match.group(0).decode('utf-8', errors='ignore')[:200],
                                'source': strings_file.name
                            })

        print(f"  Found {len(self.findings['suspicious_strings'])} suspicious patterns")

    def generate_report(self):
        """Generate comprehensive forensics report"""
        print("\nGenerating forensics report...")

        report_file = self.output_dir / "forensics-report.txt"

        with open(report_file, 'w') as f:
            f.write("CONTAINER MEMORY FORENSICS REPORT\n")
            f.write("=" * 80 + "\n\n")
            f.write(f"Memory Dump: {self.memory_dump}\n")
            f.write(f"Analysis Date: {subprocess.check_output(['date']).decode().strip()}\n")
            f.write(f"Analyst: {os.environ.get('USER', 'Unknown')}\n\n")

            # Credentials section
            f.write("CREDENTIALS AND SECRETS\n")
            f.write("-" * 80 + "\n")
            if self.findings['credentials']:
                cred_types = {}
                for cred in self.findings['credentials']:
                    cred_type = cred['type']
                    if cred_type not in cred_types:
                        cred_types[cred_type] = []
                    cred_types[cred_type].append(cred)

                for cred_type, creds in cred_types.items():
                    f.write(f"\n{cred_type.upper().replace('_', ' ')}: {len(creds)} found\n")
                    for i, cred in enumerate(creds[:10], 1):  # Limit to 10 per type
                        f.write(f"  [{i}] {cred['value']}\n")
                    if len(creds) > 10:
                        f.write(f"  ... and {len(creds) - 10} more\n")
            else:
                f.write("No credentials found\n")

            # Network artifacts
            f.write("\n\nNETWORK ARTIFACTS\n")
            f.write("-" * 80 + "\n")
            if self.findings['network_artifacts']:
                artifact_types = {}
                for artifact in self.findings['network_artifacts']:
                    artifact_type = artifact['type']
                    if artifact_type not in artifact_types:
                        artifact_types[artifact_type] = set()
                    artifact_types[artifact_type].add(artifact['value'])

                for artifact_type, artifacts in artifact_types.items():
                    f.write(f"\n{artifact_type.upper().replace('_', ' ')}: {len(artifacts)} unique\n")
                    for i, artifact in enumerate(sorted(artifacts)[:20], 1):
                        f.write(f"  [{i}] {artifact}\n")
                    if len(artifacts) > 20:
                        f.write(f"  ... and {len(artifacts) - 20} more\n")
            else:
                f.write("No network artifacts found\n")

            # Cryptographic material
            f.write("\n\nCRYPTOGRAPHIC MATERIAL\n")
            f.write("-" * 80 + "\n")
            if self.findings['crypto_keys']:
                for i, key in enumerate(self.findings['crypto_keys'][:5], 1):
                    f.write(f"\n[{i}] {key['type'].upper()}:\n")
                    f.write(f"{key['value'][:200]}\n")
                if len(self.findings['crypto_keys']) > 5:
                    f.write(f"\n... and {len(self.findings['crypto_keys']) - 5} more\n")
            else:
                f.write("No cryptographic material found\n")

            # Suspicious patterns
            f.write("\n\nSUSPICIOUS PATTERNS (POTENTIAL MALWARE/ATTACKS)\n")
            f.write("-" * 80 + "\n")
            if self.findings['suspicious_strings']:
                pattern_types = {}
                for pattern in self.findings['suspicious_strings']:
                    pattern_type = pattern['type']
                    if pattern_type not in pattern_types:
                        pattern_types[pattern_type] = []
                    pattern_types[pattern_type].append(pattern)

                for pattern_type, patterns in pattern_types.items():
                    f.write(f"\n{pattern_type.upper().replace('_', ' ')}: {len(patterns)} indicators\n")
                    for i, pattern in enumerate(patterns[:10], 1):
                        f.write(f"  [{i}] {pattern['value']}\n")
                    if len(patterns) > 10:
                        f.write(f"  ... and {len(patterns) - 10} more\n")
            else:
                f.write("No suspicious patterns found\n")

            # File artifacts
            f.write("\n\nFILE ARTIFACTS\n")
            f.write("-" * 80 + "\n")
            if self.findings['file_artifacts']:
                f.write(f"Total file paths found: {len(self.findings['file_artifacts'])}\n\n")
                interesting_paths = [
                    p for p in self.findings['file_artifacts']
                    if any(x in p['value'].lower() for x in ['tmp', 'var', 'etc', 'root', 'home'])
                ]
                f.write("Interesting paths:\n")
                for i, path in enumerate(sorted(interesting_paths, key=lambda x: x['value'])[:50], 1):
                    f.write(f"  [{i}] {path['value']}\n")
            else:
                f.write("No file artifacts found\n")

            # Summary
            f.write("\n\nSUMMARY\n")
            f.write("-" * 80 + "\n")
            f.write(f"Credentials found: {len(self.findings['credentials'])}\n")
            f.write(f"Network artifacts: {len(self.findings['network_artifacts'])}\n")
            f.write(f"Cryptographic keys: {len(self.findings['crypto_keys'])}\n")
            f.write(f"Suspicious patterns: {len(self.findings['suspicious_strings'])}\n")
            f.write(f"File artifacts: {len(self.findings['file_artifacts'])}\n")

        # Save JSON report
        json_file = self.output_dir / "forensics-report.json"
        with open(json_file, 'w') as f:
            json.dump(self.findings, f, indent=2)

        print(f"Report generated: {report_file}")
        print(f"JSON report: {json_file}")

def main():
    if len(sys.argv) < 2:
        print("Usage: container-memory-analyzer.py <memory-dump> [output-dir]")
        sys.exit(1)

    memory_dump = sys.argv[1]
    output_dir = sys.argv[2] if len(sys.argv) > 2 else "./memory-analysis"

    analyzer = ContainerMemoryAnalyzer(memory_dump, output_dir)
    analyzer.analyze()

if __name__ == "__main__":
    main()
```

## Conclusion

Container memory forensics is a critical capability for incident response teams investigating security incidents in containerized environments. By combining proper memory capture techniques with comprehensive analysis workflows, organizations can extract valuable forensic artifacts even from ephemeral container workloads.

Key takeaways:

1. **Capture Early**: Container memory is volatile; capture as soon as an incident is detected
2. **Multiple Methods**: Use multiple capture techniques to ensure comprehensive evidence collection
3. **Automate Analysis**: Automated analysis tools can quickly identify key artifacts and indicators
4. **Preserve Context**: Capture process information, network state, and filesystem alongside memory
5. **Handle with Care**: Maintain chain of custody and evidence integrity throughout the process

The tools and techniques presented provide a foundation for enterprise-grade container memory forensics, enabling security teams to effectively investigate incidents and extract critical evidence from containerized workloads.
