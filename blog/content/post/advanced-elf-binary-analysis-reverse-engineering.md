---
title: "Advanced ELF Binary Analysis and Reverse Engineering Techniques"
date: 2025-02-26T10:00:00-05:00
draft: false
tags: ["Linux", "ELF", "Binary Analysis", "Reverse Engineering", "Security", "Malware Analysis", "Debugging"]
categories:
- Linux
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Master ELF binary analysis and reverse engineering with advanced techniques for static and dynamic analysis, anti-debugging bypass, and malware investigation"
more_link: "yes"
url: "/advanced-elf-binary-analysis-reverse-engineering/"
---

Understanding ELF (Executable and Linkable Format) binaries is fundamental to Linux security, malware analysis, and systems programming. This guide explores advanced techniques for analyzing, reverse engineering, and understanding binary executables at the deepest level.

<!--more-->

# [Advanced ELF Binary Analysis](#advanced-elf-binary-analysis)

## ELF Format Deep Dive

### ELF Header Analysis

```c
// elf_analyzer.c - Comprehensive ELF analysis tool
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <elf.h>
#include <endian.h>

typedef struct {
    void* data;
    size_t size;
    Elf64_Ehdr* ehdr;
    Elf64_Shdr* shdrs;
    Elf64_Phdr* phdrs;
    char* strtab;
    Elf64_Sym* symtab;
    size_t symtab_count;
    char* dynstr;
    Elf64_Dyn* dynamic;
} elf_file_t;

// Load and map ELF file
elf_file_t* load_elf_file(const char* filename) {
    int fd = open(filename, O_RDONLY);
    if (fd < 0) {
        perror("open");
        return NULL;
    }
    
    struct stat st;
    if (fstat(fd, &st) < 0) {
        perror("fstat");
        close(fd);
        return NULL;
    }
    
    void* data = mmap(NULL, st.st_size, PROT_READ, MAP_PRIVATE, fd, 0);
    close(fd);
    
    if (data == MAP_FAILED) {
        perror("mmap");
        return NULL;
    }
    
    elf_file_t* elf = calloc(1, sizeof(elf_file_t));
    elf->data = data;
    elf->size = st.st_size;
    elf->ehdr = (Elf64_Ehdr*)data;
    
    // Validate ELF magic
    if (memcmp(elf->ehdr->e_ident, ELFMAG, SELFMAG) != 0) {
        fprintf(stderr, "Not an ELF file\n");
        munmap(data, st.st_size);
        free(elf);
        return NULL;
    }
    
    // Setup section and program headers
    elf->shdrs = (Elf64_Shdr*)((char*)data + elf->ehdr->e_shoff);
    elf->phdrs = (Elf64_Phdr*)((char*)data + elf->ehdr->e_phoff);
    
    // Find string table
    if (elf->ehdr->e_shstrndx != SHN_UNDEF) {
        elf->strtab = (char*)data + elf->shdrs[elf->ehdr->e_shstrndx].sh_offset;
    }
    
    return elf;
}

// Analyze ELF header
void analyze_elf_header(elf_file_t* elf) {
    Elf64_Ehdr* ehdr = elf->ehdr;
    
    printf("=== ELF Header Analysis ===\n");
    
    // ELF identification
    printf("Magic: ");
    for (int i = 0; i < EI_NIDENT; i++) {
        printf("%02x ", ehdr->e_ident[i]);
    }
    printf("\n");
    
    printf("Class: %s\n", 
           ehdr->e_ident[EI_CLASS] == ELFCLASS64 ? "ELF64" : "ELF32");
    printf("Data: %s\n",
           ehdr->e_ident[EI_DATA] == ELFDATA2LSB ? "Little-endian" : "Big-endian");
    printf("Version: %d\n", ehdr->e_ident[EI_VERSION]);
    printf("OS/ABI: %d\n", ehdr->e_ident[EI_OSABI]);
    
    // ELF type
    const char* type_str;
    switch (ehdr->e_type) {
        case ET_NONE: type_str = "None"; break;
        case ET_REL:  type_str = "Relocatable"; break;
        case ET_EXEC: type_str = "Executable"; break;
        case ET_DYN:  type_str = "Shared object"; break;
        case ET_CORE: type_str = "Core file"; break;
        default:      type_str = "Unknown"; break;
    }
    printf("Type: %s (%d)\n", type_str, ehdr->e_type);
    
    // Machine architecture
    printf("Machine: ");
    switch (ehdr->e_machine) {
        case EM_X86_64: printf("x86-64"); break;
        case EM_386:    printf("i386"); break;
        case EM_ARM:    printf("ARM"); break;
        case EM_AARCH64: printf("AArch64"); break;
        default:        printf("Unknown (%d)", ehdr->e_machine); break;
    }
    printf("\n");
    
    printf("Entry point: 0x%lx\n", ehdr->e_entry);
    printf("Program header offset: 0x%lx\n", ehdr->e_phoff);
    printf("Section header offset: 0x%lx\n", ehdr->e_shoff);
    printf("Flags: 0x%x\n", ehdr->e_flags);
    printf("Header size: %d bytes\n", ehdr->e_ehsize);
    printf("Program headers: %d entries, %d bytes each\n", 
           ehdr->e_phnum, ehdr->e_phentsize);
    printf("Section headers: %d entries, %d bytes each\n",
           ehdr->e_shnum, ehdr->e_shentsize);
    
    // Security features analysis
    printf("\n=== Security Features ===\n");
    
    // Check for stack canaries
    if (find_symbol(elf, "__stack_chk_fail")) {
        printf("Stack canaries: ENABLED\n");
    } else {
        printf("Stack canaries: DISABLED\n");
    }
    
    // Check for FORTIFY_SOURCE
    if (find_symbol(elf, "__memcpy_chk") || find_symbol(elf, "__strcpy_chk")) {
        printf("FORTIFY_SOURCE: ENABLED\n");
    } else {
        printf("FORTIFY_SOURCE: DISABLED\n");
    }
}

// Analyze program headers
void analyze_program_headers(elf_file_t* elf) {
    printf("\n=== Program Headers ===\n");
    printf("Type           Offset     VirtAddr   PhysAddr   FileSize   MemSize    Flags  Align\n");
    
    for (int i = 0; i < elf->ehdr->e_phnum; i++) {
        Elf64_Phdr* phdr = &elf->phdrs[i];
        
        const char* type_str;
        switch (phdr->p_type) {
            case PT_NULL:    type_str = "NULL"; break;
            case PT_LOAD:    type_str = "LOAD"; break;
            case PT_DYNAMIC: type_str = "DYNAMIC"; break;
            case PT_INTERP:  type_str = "INTERP"; break;
            case PT_NOTE:    type_str = "NOTE"; break;
            case PT_SHLIB:   type_str = "SHLIB"; break;
            case PT_PHDR:    type_str = "PHDR"; break;
            case PT_TLS:     type_str = "TLS"; break;
            case PT_GNU_STACK: type_str = "GNU_STACK"; break;
            case PT_GNU_RELRO: type_str = "GNU_RELRO"; break;
            default:         type_str = "UNKNOWN"; break;
        }
        
        printf("%-14s 0x%08lx 0x%08lx 0x%08lx 0x%08lx 0x%08lx ",
               type_str, phdr->p_offset, phdr->p_vaddr, phdr->p_paddr,
               phdr->p_filesz, phdr->p_memsz);
        
        // Flags
        printf("%c%c%c ",
               (phdr->p_flags & PF_R) ? 'R' : ' ',
               (phdr->p_flags & PF_W) ? 'W' : ' ',
               (phdr->p_flags & PF_X) ? 'X' : ' ');
        
        printf("0x%lx\n", phdr->p_align);
        
        // Security analysis
        if (phdr->p_type == PT_GNU_STACK) {
            if (phdr->p_flags & PF_X) {
                printf("  WARNING: Executable stack detected!\n");
            } else {
                printf("  INFO: Non-executable stack (NX bit)\n");
            }
        }
        
        if (phdr->p_type == PT_GNU_RELRO) {
            printf("  INFO: RELRO (Relocation Read-Only) enabled\n");
        }
    }
}

// Find symbol in symbol table
Elf64_Sym* find_symbol(elf_file_t* elf, const char* name) {
    if (!elf->symtab || !elf->strtab) return NULL;
    
    for (size_t i = 0; i < elf->symtab_count; i++) {
        const char* sym_name = elf->strtab + elf->symtab[i].st_name;
        if (strcmp(sym_name, name) == 0) {
            return &elf->symtab[i];
        }
    }
    return NULL;
}

// Disassemble function
void disassemble_function(elf_file_t* elf, const char* func_name) {
    Elf64_Sym* sym = find_symbol(elf, func_name);
    if (!sym) {
        printf("Function %s not found\n", func_name);
        return;
    }
    
    printf("\n=== Disassembly of %s ===\n", func_name);
    printf("Address: 0x%lx, Size: %lu bytes\n", sym->st_value, sym->st_size);
    
    // Convert virtual address to file offset
    uint64_t file_offset = vaddr_to_file_offset(elf, sym->st_value);
    if (file_offset == 0) {
        printf("Could not convert virtual address to file offset\n");
        return;
    }
    
    // Simple disassembly (x86-64 specific)
    uint8_t* code = (uint8_t*)elf->data + file_offset;
    for (size_t i = 0; i < sym->st_size && i < 64; i++) {
        if (i % 16 == 0) {
            printf("\n0x%08lx: ", sym->st_value + i);
        }
        printf("%02x ", code[i]);
    }
    printf("\n");
}

// Convert virtual address to file offset
uint64_t vaddr_to_file_offset(elf_file_t* elf, uint64_t vaddr) {
    for (int i = 0; i < elf->ehdr->e_phnum; i++) {
        Elf64_Phdr* phdr = &elf->phdrs[i];
        if (phdr->p_type == PT_LOAD &&
            vaddr >= phdr->p_vaddr &&
            vaddr < phdr->p_vaddr + phdr->p_memsz) {
            return phdr->p_offset + (vaddr - phdr->p_vaddr);
        }
    }
    return 0;
}
```

### Section Header Analysis

```c
// Analyze section headers
void analyze_section_headers(elf_file_t* elf) {
    printf("\n=== Section Headers ===\n");
    printf("Name                Type         Address    Offset     Size       Flags\n");
    
    for (int i = 0; i < elf->ehdr->e_shnum; i++) {
        Elf64_Shdr* shdr = &elf->shdrs[i];
        const char* name = elf->strtab ? elf->strtab + shdr->sh_name : "?";
        
        const char* type_str;
        switch (shdr->sh_type) {
            case SHT_NULL:     type_str = "NULL"; break;
            case SHT_PROGBITS: type_str = "PROGBITS"; break;
            case SHT_SYMTAB:   type_str = "SYMTAB"; break;
            case SHT_STRTAB:   type_str = "STRTAB"; break;
            case SHT_RELA:     type_str = "RELA"; break;
            case SHT_HASH:     type_str = "HASH"; break;
            case SHT_DYNAMIC:  type_str = "DYNAMIC"; break;
            case SHT_NOTE:     type_str = "NOTE"; break;
            case SHT_NOBITS:   type_str = "NOBITS"; break;
            case SHT_REL:      type_str = "REL"; break;
            case SHT_DYNSYM:   type_str = "DYNSYM"; break;
            default:           type_str = "UNKNOWN"; break;
        }
        
        printf("%-19s %-12s 0x%08lx 0x%08lx 0x%08lx ",
               name, type_str, shdr->sh_addr, shdr->sh_offset, shdr->sh_size);
        
        // Flags
        if (shdr->sh_flags & SHF_WRITE) printf("W");
        if (shdr->sh_flags & SHF_ALLOC) printf("A");
        if (shdr->sh_flags & SHF_EXECINSTR) printf("X");
        printf("\n");
        
        // Store important sections
        if (shdr->sh_type == SHT_SYMTAB) {
            elf->symtab = (Elf64_Sym*)((char*)elf->data + shdr->sh_offset);
            elf->symtab_count = shdr->sh_size / sizeof(Elf64_Sym);
        }
        if (shdr->sh_type == SHT_DYNAMIC) {
            elf->dynamic = (Elf64_Dyn*)((char*)elf->data + shdr->sh_offset);
        }
    }
}

// Extract and analyze strings
void analyze_strings(elf_file_t* elf, size_t min_length) {
    printf("\n=== String Analysis (min length: %zu) ===\n", min_length);
    
    char* data = (char*)elf->data;
    size_t current_len = 0;
    size_t start = 0;
    
    for (size_t i = 0; i < elf->size; i++) {
        if (data[i] >= 32 && data[i] <= 126) {
            if (current_len == 0) start = i;
            current_len++;
        } else {
            if (current_len >= min_length) {
                printf("0x%08zx: ", start);
                for (size_t j = start; j < start + current_len; j++) {
                    printf("%c", data[j]);
                }
                printf("\n");
            }
            current_len = 0;
        }
    }
}
```

## Dynamic Analysis Techniques

### Runtime Binary Instrumentation

```c
// binary_tracer.c - Runtime binary analysis using ptrace
#include <sys/ptrace.h>
#include <sys/wait.h>
#include <sys/user.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>

typedef struct {
    pid_t pid;
    struct user_regs_struct regs;
    long orig_instruction;
    void* breakpoint_addr;
} tracer_t;

// Attach to running process
tracer_t* attach_to_process(pid_t pid) {
    tracer_t* tracer = malloc(sizeof(tracer_t));
    tracer->pid = pid;
    
    if (ptrace(PTRACE_ATTACH, pid, NULL, NULL) == -1) {
        perror("ptrace attach");
        free(tracer);
        return NULL;
    }
    
    // Wait for process to stop
    int status;
    waitpid(pid, &status, 0);
    
    printf("Attached to process %d\n", pid);
    return tracer;
}

// Set breakpoint at address
int set_breakpoint(tracer_t* tracer, void* addr) {
    // Read original instruction
    tracer->orig_instruction = ptrace(PTRACE_PEEKTEXT, tracer->pid, addr, NULL);
    if (tracer->orig_instruction == -1) {
        perror("ptrace peek");
        return -1;
    }
    
    // Write INT3 (0xCC) instruction
    long trap_instruction = (tracer->orig_instruction & ~0xFF) | 0xCC;
    if (ptrace(PTRACE_POKETEXT, tracer->pid, addr, trap_instruction) == -1) {
        perror("ptrace poke");
        return -1;
    }
    
    tracer->breakpoint_addr = addr;
    printf("Breakpoint set at %p\n", addr);
    return 0;
}

// Handle breakpoint hit
void handle_breakpoint(tracer_t* tracer) {
    // Get registers
    if (ptrace(PTRACE_GETREGS, tracer->pid, NULL, &tracer->regs) == -1) {
        perror("ptrace getregs");
        return;
    }
    
    printf("Breakpoint hit at 0x%llx\n", tracer->regs.rip - 1);
    printf("RAX: 0x%llx, RBX: 0x%llx, RCX: 0x%llx, RDX: 0x%llx\n",
           tracer->regs.rax, tracer->regs.rbx, tracer->regs.rcx, tracer->regs.rdx);
    
    // Restore original instruction
    ptrace(PTRACE_POKETEXT, tracer->pid, tracer->breakpoint_addr, 
           tracer->orig_instruction);
    
    // Move instruction pointer back
    tracer->regs.rip--;
    ptrace(PTRACE_SETREGS, tracer->pid, NULL, &tracer->regs);
}

// Syscall tracer
void trace_syscalls(tracer_t* tracer) {
    printf("Tracing system calls...\n");
    
    while (1) {
        // Continue until next syscall
        if (ptrace(PTRACE_SYSCALL, tracer->pid, NULL, NULL) == -1) {
            perror("ptrace syscall");
            break;
        }
        
        int status;
        waitpid(tracer->pid, &status, 0);
        
        if (WIFEXITED(status)) {
            printf("Process exited\n");
            break;
        }
        
        if (WIFSTOPPED(status)) {
            ptrace(PTRACE_GETREGS, tracer->pid, NULL, &tracer->regs);
            
            // Check if it's a syscall entry or exit
            static int syscall_entry = 1;
            if (syscall_entry) {
                printf("SYSCALL: %lld(0x%llx, 0x%llx, 0x%llx)\n",
                       tracer->regs.orig_rax, tracer->regs.rdi, 
                       tracer->regs.rsi, tracer->regs.rdx);
            } else {
                printf("RETURN: %lld\n", tracer->regs.rax);
            }
            syscall_entry = !syscall_entry;
        }
    }
}

// Memory analysis
void analyze_memory_regions(pid_t pid) {
    char maps_path[256];
    snprintf(maps_path, sizeof(maps_path), "/proc/%d/maps", pid);
    
    FILE* maps = fopen(maps_path, "r");
    if (!maps) {
        perror("fopen maps");
        return;
    }
    
    printf("\n=== Memory Regions ===\n");
    printf("Address Range         Perms  Offset   Device   Inode    Path\n");
    
    char line[1024];
    while (fgets(line, sizeof(line), maps)) {
        printf("%s", line);
    }
    
    fclose(maps);
}

// Code injection
int inject_shellcode(tracer_t* tracer, void* addr, const char* shellcode, size_t len) {
    printf("Injecting %zu bytes of code at %p\n", len, addr);
    
    // Save original memory
    long* orig_data = malloc(((len + sizeof(long) - 1) / sizeof(long)) * sizeof(long));
    
    for (size_t i = 0; i < len; i += sizeof(long)) {
        orig_data[i / sizeof(long)] = ptrace(PTRACE_PEEKTEXT, tracer->pid, 
                                           (char*)addr + i, NULL);
    }
    
    // Write shellcode
    for (size_t i = 0; i < len; i += sizeof(long)) {
        long data = 0;
        memcpy(&data, shellcode + i, 
               (len - i < sizeof(long)) ? len - i : sizeof(long));
        
        if (ptrace(PTRACE_POKETEXT, tracer->pid, (char*)addr + i, data) == -1) {
            perror("ptrace poke shellcode");
            free(orig_data);
            return -1;
        }
    }
    
    printf("Shellcode injected successfully\n");
    free(orig_data);
    return 0;
}
```

### Function Hooking and Interception

```c
// function_hook.c - Library function interception
#include <dlfcn.h>
#include <stdio.h>
#include <string.h>

// Hook malloc to track allocations
static void* (*real_malloc)(size_t) = NULL;
static void (*real_free)(void*) = NULL;
static size_t total_allocated = 0;

void* malloc(size_t size) {
    if (!real_malloc) {
        real_malloc = dlsym(RTLD_NEXT, "malloc");
    }
    
    void* ptr = real_malloc(size);
    total_allocated += size;
    
    printf("malloc(%zu) = %p (total: %zu)\n", size, ptr, total_allocated);
    return ptr;
}

void free(void* ptr) {
    if (!real_free) {
        real_free = dlsym(RTLD_NEXT, "free");
    }
    
    printf("free(%p)\n", ptr);
    real_free(ptr);
}

// Hook specific functions for analysis
int (*orig_open)(const char*, int, ...) = NULL;

int open(const char* pathname, int flags, ...) {
    if (!orig_open) {
        orig_open = dlsym(RTLD_NEXT, "open");
    }
    
    printf("HOOK: open(\"%s\", 0x%x)\n", pathname, flags);
    
    va_list args;
    va_start(args, flags);
    mode_t mode = va_arg(args, mode_t);
    va_end(args);
    
    int result = orig_open(pathname, flags, mode);
    printf("HOOK: open() returned %d\n", result);
    
    return result;
}
```

## Anti-Debugging Detection and Bypass

### Common Anti-Debugging Techniques

```c
// anti_debug.c - Anti-debugging techniques and bypasses
#include <sys/ptrace.h>
#include <sys/prctl.h>
#include <signal.h>
#include <unistd.h>
#include <stdio.h>
#include <string.h>

// Check if being debugged via ptrace
int check_ptrace_debugger() {
    if (ptrace(PTRACE_TRACEME, 0, NULL, NULL) == -1) {
        printf("Debugger detected via ptrace!\n");
        return 1;
    }
    return 0;
}

// Check /proc/self/status for TracerPid
int check_proc_status() {
    FILE* fp = fopen("/proc/self/status", "r");
    if (!fp) return 0;
    
    char line[256];
    while (fgets(line, sizeof(line), fp)) {
        if (strncmp(line, "TracerPid:", 10) == 0) {
            int tracer_pid = atoi(line + 10);
            fclose(fp);
            if (tracer_pid != 0) {
                printf("Debugger detected via /proc/self/status (PID: %d)!\n", tracer_pid);
                return 1;
            }
            return 0;
        }
    }
    fclose(fp);
    return 0;
}

// Check for breakpoints by analyzing code
int check_software_breakpoints() {
    unsigned char* code = (unsigned char*)check_software_breakpoints;
    
    for (int i = 0; i < 100; i++) {
        if (code[i] == 0xCC) {  // INT3 instruction
            printf("Software breakpoint detected at offset %d!\n", i);
            return 1;
        }
    }
    return 0;
}

// Timing-based debugger detection
int check_timing() {
    struct timespec start, end;
    clock_gettime(CLOCK_MONOTONIC, &start);
    
    // Some dummy operations
    volatile int x = 0;
    for (int i = 0; i < 1000; i++) {
        x += i;
    }
    
    clock_gettime(CLOCK_MONOTONIC, &end);
    
    long long diff = (end.tv_sec - start.tv_sec) * 1000000000LL + 
                     (end.tv_nsec - start.tv_nsec);
    
    if (diff > 1000000) {  // More than 1ms
        printf("Debugger detected via timing (took %lld ns)!\n", diff);
        return 1;
    }
    return 0;
}

// SIGTRAP handler for hardware breakpoint detection
void sigtrap_handler(int sig) {
    printf("Hardware breakpoint or single-step detected!\n");
    exit(1);
}

// Check for hardware breakpoints
void check_hardware_breakpoints() {
    signal(SIGTRAP, sigtrap_handler);
    
    // Set debug registers would trigger SIGTRAP if monitored
    asm volatile ("int $3");  // This should be caught by our handler
}

// Advanced: Check for specific debugger processes
int check_debugger_processes() {
    const char* debuggers[] = {
        "gdb", "lldb", "strace", "ltrace", "radare2", "ida", "x64dbg"
    };
    
    for (int i = 0; i < sizeof(debuggers)/sizeof(debuggers[0]); i++) {
        char cmd[256];
        snprintf(cmd, sizeof(cmd), "pgrep %s > /dev/null 2>&1", debuggers[i]);
        if (system(cmd) == 0) {
            printf("Debugger process detected: %s\n", debuggers[i]);
            return 1;
        }
    }
    return 0;
}

// Environment-based detection
int check_debug_environment() {
    // Check for common debugging environment variables
    if (getenv("LD_PRELOAD")) {
        printf("LD_PRELOAD detected: %s\n", getenv("LD_PRELOAD"));
        return 1;
    }
    
    if (getenv("GDBSERVER_PORT")) {
        printf("GDB server environment detected\n");
        return 1;
    }
    
    return 0;
}
```

### Anti-Debugging Bypass Techniques

```bash
#!/bin/bash
# bypass_anti_debug.sh - Anti-debugging bypass techniques

# Method 1: Patch binary to skip anti-debug checks
patch_binary_checks() {
    local binary=$1
    local backup="${binary}.backup"
    
    echo "Creating backup: $backup"
    cp "$binary" "$backup"
    
    # Replace ptrace calls with NOPs (x86-64)
    # ptrace syscall number is 101 (0x65)
    echo "Patching ptrace calls..."
    
    # Find and replace ptrace syscall instructions
    python3 << 'EOF'
import sys
with open(sys.argv[1], 'rb') as f:
    data = bytearray(f.read())

# Pattern for ptrace syscall: mov rax, 101; syscall
ptrace_pattern = b'\x48\xc7\xc0\x65\x00\x00\x00\x0f\x05'
nop_replacement = b'\x90' * len(ptrace_pattern)

count = 0
i = 0
while i < len(data) - len(ptrace_pattern):
    if data[i:i+len(ptrace_pattern)] == ptrace_pattern:
        data[i:i+len(ptrace_pattern)] = nop_replacement
        count += 1
        i += len(ptrace_pattern)
    else:
        i += 1

print(f"Patched {count} ptrace calls")

with open(sys.argv[1], 'wb') as f:
    f.write(data)
EOF "$binary"
}

# Method 2: Use LD_PRELOAD to hook anti-debug functions
create_anti_debug_bypass() {
    cat > anti_debug_bypass.c << 'EOF'
#include <sys/ptrace.h>

// Always return success for ptrace TRACEME
long ptrace(enum __ptrace_request request, pid_t pid, void *addr, void *data) {
    if (request == PTRACE_TRACEME) {
        return 0;  // Pretend success
    }
    // For other ptrace calls, use original function
    return real_ptrace(request, pid, addr, data);
}
EOF
    
    gcc -shared -fPIC anti_debug_bypass.c -o anti_debug_bypass.so -ldl
    echo "Created anti_debug_bypass.so"
    echo "Use with: LD_PRELOAD=./anti_debug_bypass.so ./target_binary"
}

# Method 3: Kernel module to hide debugger
create_stealth_debugger() {
    cat > stealth_debug.c << 'EOF'
// Kernel module to hide debugging activities
#include <linux/module.h>
#include <linux/kernel.h>
#include <linux/syscalls.h>
#include <linux/kallsyms.h>

static unsigned long *sys_call_table;
asmlinkage long (*original_ptrace)(long request, long pid, unsigned long addr, unsigned long data);

// Hooked ptrace that hides debugging
asmlinkage long hooked_ptrace(long request, long pid, unsigned long addr, unsigned long data) {
    // Hide PTRACE_TRACEME from target processes
    if (request == PTRACE_TRACEME) {
        // Check if this is our target process
        if (should_hide_debugging(current->pid)) {
            return -EPERM;  // Pretend ptrace failed
        }
    }
    return original_ptrace(request, pid, addr, data);
}

static int __init stealth_init(void) {
    // Find system call table
    sys_call_table = (unsigned long *)kallsyms_lookup_name("sys_call_table");
    
    // Hook ptrace
    original_ptrace = (void *)sys_call_table[__NR_ptrace];
    sys_call_table[__NR_ptrace] = (unsigned long)hooked_ptrace;
    
    return 0;
}

static void __exit stealth_exit(void) {
    sys_call_table[__NR_ptrace] = (unsigned long)original_ptrace;
}

module_init(stealth_init);
module_exit(stealth_exit);
MODULE_LICENSE("GPL");
EOF
}

# Method 4: GDB scripting to automate bypass
create_gdb_bypass_script() {
    cat > gdb_bypass.py << 'EOF'
import gdb

class AntiDebugBypass(gdb.Command):
    def __init__(self):
        super(AntiDebugBypass, self).__init__("bypass-antidebug", gdb.COMMAND_USER)
    
    def invoke(self, arg, from_tty):
        # Set breakpoint on ptrace
        gdb.execute("break ptrace")
        gdb.execute("commands")
        gdb.execute("silent")
        gdb.execute("set $rax = 0")  # Force ptrace to return 0
        gdb.execute("continue")
        gdb.execute("end")
        
        # Patch timing checks
        gdb.execute("break clock_gettime")
        gdb.execute("commands")
        gdb.execute("silent")
        # Modify timing to appear normal
        gdb.execute("continue")
        gdb.execute("end")
        
        print("Anti-debugging bypass enabled")

AntiDebugBypass()

# Auto-run bypass
gdb.execute("bypass-antidebug")
EOF
    
    echo "GDB bypass script created: gdb_bypass.py"
    echo "Use with: gdb -x gdb_bypass.py ./target_binary"
}
```

## Advanced Analysis Techniques

### Control Flow Analysis

```python
#!/usr/bin/env python3
# control_flow_analysis.py - Advanced control flow analysis

import sys
import struct
from capstone import *

class ControlFlowAnalyzer:
    def __init__(self, binary_path):
        self.binary_path = binary_path
        self.binary_data = open(binary_path, 'rb').read()
        self.md = Cs(CS_ARCH_X86, CS_MODE_64)
        self.md.detail = True
        
        self.functions = {}
        self.basic_blocks = {}
        self.call_graph = {}
        
    def find_functions(self, start_addr, end_addr):
        """Find all functions in the given address range"""
        offset = start_addr
        
        while offset < end_addr:
            # Look for function prologue patterns
            if self.is_function_start(offset):
                func_addr = offset
                func_end = self.find_function_end(offset)
                
                if func_end:
                    self.functions[func_addr] = {
                        'start': func_addr,
                        'end': func_end,
                        'size': func_end - func_addr,
                        'basic_blocks': [],
                        'calls': []
                    }
                    print(f"Found function: 0x{func_addr:x} - 0x{func_end:x}")
                    
                    # Analyze basic blocks within function
                    self.analyze_basic_blocks(func_addr, func_end)
                    
                offset = func_end
            else:
                offset += 1
    
    def is_function_start(self, offset):
        """Check if offset points to a function start"""
        # Look for common function prologue patterns
        data = self.binary_data[offset:offset+8]
        
        # Standard function prologue: push rbp; mov rbp, rsp
        if data.startswith(b'\x55\x48\x89\xe5'):
            return True
        
        # Alternative prologue: sub rsp, imm
        if data.startswith(b'\x48\x83\xec'):
            return True
            
        return False
    
    def find_function_end(self, start):
        """Find the end of a function starting at 'start'"""
        offset = start
        
        while offset < len(self.binary_data) - 8:
            try:
                insns = list(self.md.disasm(self.binary_data[offset:offset+16], offset))
                if insns:
                    insn = insns[0]
                    
                    # Function ends with return
                    if insn.mnemonic == 'ret':
                        return offset + insn.size
                    
                    # Or with jump to another function
                    if insn.mnemonic == 'jmp' and self.is_external_jump(insn):
                        return offset
                    
                    offset += insn.size
                else:
                    offset += 1
            except:
                offset += 1
                
        return None
    
    def analyze_basic_blocks(self, func_start, func_end):
        """Analyze basic blocks within a function"""
        leaders = {func_start}  # Start of function is a leader
        
        # First pass: find all leaders
        offset = func_start
        while offset < func_end:
            try:
                insns = list(self.md.disasm(self.binary_data[offset:offset+16], offset))
                if insns:
                    insn = insns[0]
                    
                    # Branch targets are leaders
                    if insn.mnemonic.startswith('j'):
                        if len(insn.operands) > 0 and insn.operands[0].type == CS_OP_IMM:
                            target = insn.operands[0].imm
                            if func_start <= target < func_end:
                                leaders.add(target)
                                leaders.add(offset + insn.size)  # Instruction after branch
                    
                    # Call targets
                    elif insn.mnemonic == 'call':
                        leaders.add(offset + insn.size)  # Instruction after call
                    
                    offset += insn.size
                else:
                    offset += 1
            except:
                offset += 1
        
        # Second pass: create basic blocks
        leaders = sorted(leaders)
        for i in range(len(leaders)):
            start = leaders[i]
            end = leaders[i + 1] if i + 1 < len(leaders) else func_end
            
            if start < func_end:
                self.basic_blocks[start] = {
                    'start': start,
                    'end': end,
                    'instructions': self.disassemble_block(start, end),
                    'successors': [],
                    'predecessors': []
                }
        
        # Third pass: connect basic blocks
        self.connect_basic_blocks(func_start, func_end)
    
    def disassemble_block(self, start, end):
        """Disassemble a basic block"""
        instructions = []
        offset = start
        
        while offset < end:
            try:
                insns = list(self.md.disasm(self.binary_data[offset:offset+16], offset))
                if insns:
                    insn = insns[0]
                    instructions.append({
                        'address': insn.address,
                        'mnemonic': insn.mnemonic,
                        'op_str': insn.op_str,
                        'bytes': insn.bytes
                    })
                    offset += insn.size
                else:
                    break
            except:
                break
                
        return instructions
    
    def connect_basic_blocks(self, func_start, func_end):
        """Connect basic blocks with edges"""
        for bb_addr in self.basic_blocks:
            if bb_addr < func_start or bb_addr >= func_end:
                continue
                
            bb = self.basic_blocks[bb_addr]
            last_insn = bb['instructions'][-1] if bb['instructions'] else None
            
            if last_insn:
                mnemonic = last_insn['mnemonic']
                
                # Unconditional jump
                if mnemonic == 'jmp':
                    target = self.get_jump_target(last_insn)
                    if target and target in self.basic_blocks:
                        bb['successors'].append(target)
                        self.basic_blocks[target]['predecessors'].append(bb_addr)
                
                # Conditional jump
                elif mnemonic.startswith('j') and mnemonic != 'jmp':
                    # Branch target
                    target = self.get_jump_target(last_insn)
                    if target and target in self.basic_blocks:
                        bb['successors'].append(target)
                        self.basic_blocks[target]['predecessors'].append(bb_addr)
                    
                    # Fall-through target
                    fall_through = bb['end']
                    if fall_through in self.basic_blocks:
                        bb['successors'].append(fall_through)
                        self.basic_blocks[fall_through]['predecessors'].append(bb_addr)
                
                # Return ends the flow
                elif mnemonic == 'ret':
                    pass  # No successors
                
                # Other instructions fall through
                else:
                    fall_through = bb['end']
                    if fall_through in self.basic_blocks:
                        bb['successors'].append(fall_through)
                        self.basic_blocks[fall_through]['predecessors'].append(bb_addr)
    
    def get_jump_target(self, instruction):
        """Extract jump target from instruction"""
        # This is simplified - real implementation would parse operands
        op_str = instruction['op_str']
        if op_str.startswith('0x'):
            return int(op_str, 16)
        return None
    
    def detect_obfuscation(self):
        """Detect common obfuscation techniques"""
        obfuscation_indicators = []
        
        for func_addr, func in self.functions.items():
            # Check for excessive branching (control flow obfuscation)
            total_blocks = len([bb for bb in self.basic_blocks.values() 
                               if func['start'] <= bb['start'] < func['end']])
            avg_block_size = func['size'] / max(total_blocks, 1)
            
            if avg_block_size < 5:  # Very small basic blocks
                obfuscation_indicators.append(f"Function 0x{func_addr:x}: Suspicious small basic blocks")
            
            # Check for dead code
            unreachable_blocks = self.find_unreachable_blocks(func_addr)
            if unreachable_blocks:
                obfuscation_indicators.append(f"Function 0x{func_addr:x}: Dead code detected")
            
            # Check for opaque predicates
            if self.detect_opaque_predicates(func_addr):
                obfuscation_indicators.append(f"Function 0x{func_addr:x}: Possible opaque predicates")
        
        return obfuscation_indicators
    
    def find_unreachable_blocks(self, func_addr):
        """Find unreachable basic blocks using DFS"""
        func = self.functions[func_addr]
        reachable = set()
        stack = [func_addr]
        
        while stack:
            current = stack.pop()
            if current not in reachable:
                reachable.add(current)
                if current in self.basic_blocks:
                    stack.extend(self.basic_blocks[current]['successors'])
        
        # Find all blocks in function
        all_blocks = {bb for bb in self.basic_blocks 
                     if func['start'] <= bb < func['end']}
        
        return all_blocks - reachable
    
    def detect_opaque_predicates(self, func_addr):
        """Detect opaque predicates (always true/false conditions)"""
        # Look for patterns like: xor eax, eax; test eax, eax; jz
        func = self.functions[func_addr]
        
        for bb_addr in self.basic_blocks:
            if not (func['start'] <= bb_addr < func['end']):
                continue
                
            bb = self.basic_blocks[bb_addr]
            instructions = bb['instructions']
            
            for i in range(len(instructions) - 2):
                # Pattern: xor reg, reg; test reg, reg; conditional jump
                if (instructions[i]['mnemonic'] == 'xor' and
                    instructions[i+1]['mnemonic'] == 'test' and
                    instructions[i+2]['mnemonic'].startswith('j')):
                    
                    # Check if same register is used
                    xor_ops = instructions[i]['op_str'].split(', ')
                    test_ops = instructions[i+1]['op_str'].split(', ')
                    
                    if len(xor_ops) == 2 and xor_ops[0] == xor_ops[1]:
                        if len(test_ops) == 2 and test_ops[0] == test_ops[1]:
                            if xor_ops[0] == test_ops[0]:
                                return True
        
        return False
    
    def generate_dot_graph(self, func_addr):
        """Generate DOT graph for function control flow"""
        func = self.functions[func_addr]
        dot = f"digraph func_{func_addr:x} {{\n"
        dot += "  rankdir=TB;\n"
        dot += "  node [shape=box];\n"
        
        for bb_addr in self.basic_blocks:
            if not (func['start'] <= bb_addr < func['end']):
                continue
                
            bb = self.basic_blocks[bb_addr]
            label = f"0x{bb_addr:x}\\n"
            
            for insn in bb['instructions']:
                label += f"{insn['mnemonic']} {insn['op_str']}\\n"
            
            dot += f'  "0x{bb_addr:x}" [label="{label}"];\n'
            
            for successor in bb['successors']:
                dot += f'  "0x{bb_addr:x}" -> "0x{successor:x}";\n'
        
        dot += "}\n"
        return dot

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <binary_file>")
        sys.exit(1)
    
    analyzer = ControlFlowAnalyzer(sys.argv[1])
    
    # Analyze .text section (simplified)
    analyzer.find_functions(0x1000, 0x5000)
    
    print("\n=== Obfuscation Detection ===")
    indicators = analyzer.detect_obfuscation()
    for indicator in indicators:
        print(indicator)
    
    # Generate control flow graph for first function
    if analyzer.functions:
        first_func = next(iter(analyzer.functions))
        print(f"\n=== Control Flow Graph for 0x{first_func:x} ===")
        print(analyzer.generate_dot_graph(first_func))
```

## Malware Analysis Framework

### Automated Analysis Pipeline

```python
#!/usr/bin/env python3
# malware_analyzer.py - Comprehensive malware analysis framework

import os
import sys
import hashlib
import magic
import yara
import pefile
import subprocess
import json
from datetime import datetime

class MalwareAnalyzer:
    def __init__(self, sample_path, output_dir="analysis_output"):
        self.sample_path = sample_path
        self.output_dir = output_dir
        self.results = {
            'timestamp': datetime.now().isoformat(),
            'sample_path': sample_path,
            'basic_info': {},
            'static_analysis': {},
            'dynamic_analysis': {},
            'network_analysis': {},
            'yara_matches': [],
            'iocs': []
        }
        
        os.makedirs(output_dir, exist_ok=True)
    
    def basic_analysis(self):
        """Basic file analysis"""
        print("=== Basic Analysis ===")
        
        # File hashes
        with open(self.sample_path, 'rb') as f:
            data = f.read()
            
        self.results['basic_info'] = {
            'file_size': len(data),
            'md5': hashlib.md5(data).hexdigest(),
            'sha1': hashlib.sha1(data).hexdigest(),
            'sha256': hashlib.sha256(data).hexdigest(),
            'file_type': magic.from_file(self.sample_path),
            'mime_type': magic.from_file(self.sample_path, mime=True)
        }
        
        print(f"File size: {self.results['basic_info']['file_size']} bytes")
        print(f"MD5: {self.results['basic_info']['md5']}")
        print(f"SHA256: {self.results['basic_info']['sha256']}")
        print(f"File type: {self.results['basic_info']['file_type']}")
    
    def static_analysis(self):
        """Static analysis of the binary"""
        print("\n=== Static Analysis ===")
        
        try:
            pe = pefile.PE(self.sample_path)
            
            # PE header analysis
            self.results['static_analysis']['pe_header'] = {
                'machine': hex(pe.FILE_HEADER.Machine),
                'characteristics': hex(pe.FILE_HEADER.Characteristics),
                'timestamp': pe.FILE_HEADER.TimeDateStamp,
                'entry_point': hex(pe.OPTIONAL_HEADER.AddressOfEntryPoint),
                'image_base': hex(pe.OPTIONAL_HEADER.ImageBase)
            }
            
            # Section analysis
            sections = []
            for section in pe.sections:
                sections.append({
                    'name': section.Name.decode().rstrip('\x00'),
                    'virtual_address': hex(section.VirtualAddress),
                    'virtual_size': section.Misc_VirtualSize,
                    'raw_size': section.SizeOfRawData,
                    'characteristics': hex(section.Characteristics),
                    'entropy': section.get_entropy()
                })
            
            self.results['static_analysis']['sections'] = sections
            
            # Import analysis
            imports = []
            if hasattr(pe, 'DIRECTORY_ENTRY_IMPORT'):
                for entry in pe.DIRECTORY_ENTRY_IMPORT:
                    dll_imports = []
                    for imp in entry.imports:
                        if imp.name:
                            dll_imports.append(imp.name.decode())
                    
                    imports.append({
                        'dll': entry.dll.decode(),
                        'functions': dll_imports
                    })
            
            self.results['static_analysis']['imports'] = imports
            
            # Export analysis
            exports = []
            if hasattr(pe, 'DIRECTORY_ENTRY_EXPORT'):
                for exp in pe.DIRECTORY_ENTRY_EXPORT.symbols:
                    exports.append({
                        'name': exp.name.decode() if exp.name else f"Ordinal_{exp.ordinal}",
                        'address': hex(exp.address),
                        'ordinal': exp.ordinal
                    })
            
            self.results['static_analysis']['exports'] = exports
            
            # Resource analysis
            resources = []
            if hasattr(pe, 'DIRECTORY_ENTRY_RESOURCE'):
                for resource_type in pe.DIRECTORY_ENTRY_RESOURCE.entries:
                    for resource_id in resource_type.directory.entries:
                        for resource_lang in resource_id.directory.entries:
                            data = pe.get_data(resource_lang.data.struct.OffsetToData,
                                             resource_lang.data.struct.Size)
                            
                            resources.append({
                                'type': resource_type.id,
                                'id': resource_id.id,
                                'lang': resource_lang.id,
                                'size': resource_lang.data.struct.Size,
                                'entropy': self.calculate_entropy(data)
                            })
            
            self.results['static_analysis']['resources'] = resources
            
        except Exception as e:
            print(f"PE analysis failed: {e}")
    
    def string_analysis(self):
        """Extract and analyze strings"""
        print("\n=== String Analysis ===")
        
        # Extract ASCII strings
        ascii_strings = []
        unicode_strings = []
        
        with open(self.sample_path, 'rb') as f:
            data = f.read()
        
        # ASCII strings (minimum length 4)
        current_string = ""
        for byte in data:
            if 32 <= byte <= 126:  # Printable ASCII
                current_string += chr(byte)
            else:
                if len(current_string) >= 4:
                    ascii_strings.append(current_string)
                current_string = ""
        
        # Unicode strings
        for i in range(0, len(data) - 1, 2):
            if data[i+1] == 0 and 32 <= data[i] <= 126:
                # Start of potential Unicode string
                unicode_str = ""
                j = i
                while j < len(data) - 1 and data[j+1] == 0 and 32 <= data[j] <= 126:
                    unicode_str += chr(data[j])
                    j += 2
                
                if len(unicode_str) >= 4:
                    unicode_strings.append(unicode_str)
        
        # Filter interesting strings
        interesting_strings = []
        keywords = ['http', 'ftp', 'tcp', 'udp', 'smtp', 'pop3', 'imap',
                   'registry', 'service', 'process', 'thread', 'mutex',
                   'pipe', 'socket', 'connect', 'send', 'recv',
                   'CreateFile', 'WriteFile', 'ReadFile', 'DeleteFile']
        
        all_strings = ascii_strings + unicode_strings
        for string in all_strings:
            for keyword in keywords:
                if keyword.lower() in string.lower():
                    interesting_strings.append(string)
                    break
        
        self.results['static_analysis']['strings'] = {
            'ascii_count': len(ascii_strings),
            'unicode_count': len(unicode_strings),
            'interesting': interesting_strings[:50]  # Limit output
        }
        
        print(f"Found {len(ascii_strings)} ASCII strings")
        print(f"Found {len(unicode_strings)} Unicode strings")
        print(f"Interesting strings: {len(interesting_strings)}")
    
    def yara_scan(self, rules_dir="/opt/yara-rules"):
        """Scan with YARA rules"""
        print("\n=== YARA Analysis ===")
        
        if not os.path.exists(rules_dir):
            print("YARA rules directory not found")
            return
        
        matches = []
        for rule_file in os.listdir(rules_dir):
            if rule_file.endswith('.yar') or rule_file.endswith('.yara'):
                try:
                    rule_path = os.path.join(rules_dir, rule_file)
                    rules = yara.compile(filepath=rule_path)
                    rule_matches = rules.match(self.sample_path)
                    
                    for match in rule_matches:
                        matches.append({
                            'rule': match.rule,
                            'file': rule_file,
                            'tags': match.tags,
                            'meta': match.meta
                        })
                        
                except Exception as e:
                    print(f"Error processing {rule_file}: {e}")
        
        self.results['yara_matches'] = matches
        print(f"YARA matches: {len(matches)}")
        
        for match in matches:
            print(f"  - {match['rule']} (tags: {match['tags']})")
    
    def dynamic_analysis(self):
        """Dynamic analysis using sandbox or instrumentation"""
        print("\n=== Dynamic Analysis ===")
        
        # Create analysis script
        analysis_script = f"""
#!/bin/bash
# Dynamic analysis script for {self.sample_path}

echo "Starting dynamic analysis..."

# Monitor file system changes
echo "=== File System Monitoring ===" > {self.output_dir}/dynamic_fs.log
find /tmp /var/tmp -type f -newer {self.sample_path} 2>/dev/null >> {self.output_dir}/dynamic_fs.log &
FS_PID=$!

# Monitor network connections
echo "=== Network Monitoring ===" > {self.output_dir}/dynamic_net.log
netstat -tan > {self.output_dir}/dynamic_net_before.log

# Monitor processes
echo "=== Process Monitoring ===" > {self.output_dir}/dynamic_proc.log
ps aux > {self.output_dir}/dynamic_proc_before.log

# Run the sample with strace
echo "=== System Call Trace ===" > {self.output_dir}/dynamic_strace.log
timeout 30 strace -o {self.output_dir}/dynamic_strace.log -f -e trace=all {self.sample_path} &
SAMPLE_PID=$!

# Wait a bit then capture state
sleep 5

# Capture network state
netstat -tan > {self.output_dir}/dynamic_net_after.log
ps aux > {self.output_dir}/dynamic_proc_after.log

# Stop monitoring
kill $FS_PID 2>/dev/null
kill $SAMPLE_PID 2>/dev/null

echo "Dynamic analysis complete"
"""
        
        script_path = os.path.join(self.output_dir, "dynamic_analysis.sh")
        with open(script_path, 'w') as f:
            f.write(analysis_script)
        
        os.chmod(script_path, 0o755)
        
        # Run analysis (in controlled environment)
        print("Running dynamic analysis...")
        try:
            result = subprocess.run(['bash', script_path], 
                                  capture_output=True, text=True, timeout=60)
            
            self.results['dynamic_analysis']['exit_code'] = result.returncode
            self.results['dynamic_analysis']['stdout'] = result.stdout
            self.results['dynamic_analysis']['stderr'] = result.stderr
            
        except subprocess.TimeoutExpired:
            print("Dynamic analysis timed out")
            self.results['dynamic_analysis']['status'] = 'timeout'
    
    def extract_iocs(self):
        """Extract Indicators of Compromise"""
        print("\n=== IOC Extraction ===")
        
        iocs = {
            'file_hashes': [
                self.results['basic_info']['md5'],
                self.results['basic_info']['sha1'],
                self.results['basic_info']['sha256']
            ],
            'ip_addresses': [],
            'domains': [],
            'urls': [],
            'registry_keys': [],
            'file_paths': [],
            'mutexes': []
        }
        
        # Extract from strings
        if 'strings' in self.results['static_analysis']:
            strings = self.results['static_analysis']['strings']['interesting']
            
            import re
            
            # IP addresses
            ip_pattern = r'\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b'
            for string in strings:
                matches = re.findall(ip_pattern, string)
                iocs['ip_addresses'].extend(matches)
            
            # Domains
            domain_pattern = r'\b[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b'
            for string in strings:
                matches = re.findall(domain_pattern, string)
                iocs['domains'].extend(matches)
            
            # URLs
            url_pattern = r'https?://[^\s<>"{}|\\^`\[\]]+'
            for string in strings:
                matches = re.findall(url_pattern, string)
                iocs['urls'].extend(matches)
        
        # Remove duplicates
        for key in iocs:
            if isinstance(iocs[key], list):
                iocs[key] = list(set(iocs[key]))
        
        self.results['iocs'] = iocs
        
        print(f"Extracted {len(iocs['ip_addresses'])} IP addresses")
        print(f"Extracted {len(iocs['domains'])} domains")
        print(f"Extracted {len(iocs['urls'])} URLs")
    
    def calculate_entropy(self, data):
        """Calculate Shannon entropy of data"""
        import math
        
        if not data:
            return 0
        
        # Count frequency of each byte
        freq = {}
        for byte in data:
            freq[byte] = freq.get(byte, 0) + 1
        
        # Calculate entropy
        entropy = 0
        length = len(data)
        for count in freq.values():
            probability = count / length
            if probability > 0:
                entropy -= probability * math.log2(probability)
        
        return entropy
    
    def generate_report(self):
        """Generate comprehensive analysis report"""
        report_path = os.path.join(self.output_dir, "analysis_report.json")
        
        with open(report_path, 'w') as f:
            json.dump(self.results, f, indent=2)
        
        print(f"\nAnalysis report saved to: {report_path}")
        
        # Generate summary
        print("\n=== Analysis Summary ===")
        print(f"Sample: {self.sample_path}")
        print(f"SHA256: {self.results['basic_info']['sha256']}")
        print(f"File type: {self.results['basic_info']['file_type']}")
        
        if self.results['yara_matches']:
            print(f"YARA matches: {len(self.results['yara_matches'])}")
            
        ioc_count = sum(len(v) if isinstance(v, list) else 0 
                       for v in self.results['iocs'].values())
        print(f"IOCs extracted: {ioc_count}")
    
    def run_full_analysis(self):
        """Run complete analysis pipeline"""
        print(f"Starting malware analysis of: {self.sample_path}")
        
        self.basic_analysis()
        self.static_analysis()
        self.string_analysis()
        self.yara_scan()
        self.dynamic_analysis()
        self.extract_iocs()
        self.generate_report()

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <malware_sample>")
        sys.exit(1)
    
    analyzer = MalwareAnalyzer(sys.argv[1])
    analyzer.run_full_analysis()
```

## Best Practices

1. **Use Multiple Analysis Tools**: Combine static and dynamic analysis for comprehensive understanding
2. **Sandbox Environment**: Always analyze malware in isolated environments
3. **Automated Pipelines**: Build repeatable analysis workflows
4. **IOC Extraction**: Systematically extract and catalog indicators
5. **Version Control**: Track analysis scripts and maintain rule databases
6. **Documentation**: Thoroughly document analysis procedures and findings

## Conclusion

Advanced ELF binary analysis and reverse engineering require a deep understanding of binary formats, assembly language, and system internals. From static analysis of headers and sections to dynamic instrumentation and anti-debugging bypass, these techniques provide powerful capabilities for security research, malware analysis, and vulnerability assessment.

The tools and techniques covered here—ELF parsing, control flow analysis, anti-debugging bypass, and automated malware analysis—form the foundation of modern binary analysis. Whether you're investigating malware, analyzing vulnerabilities, or developing security tools, mastering these skills is essential for advanced Linux security work.

Remember that binary analysis is both an art and a science, requiring patience, systematic methodology, and continuous learning as attack techniques evolve. The combination of automated tools and manual analysis expertise provides the most effective approach to understanding complex binary threats.