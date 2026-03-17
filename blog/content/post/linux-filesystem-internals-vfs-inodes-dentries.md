---
title: "Linux Filesystem Internals: VFS, Inodes, and Dentries"
date: 2029-05-23T00:00:00-05:00
draft: false
tags: ["Linux", "Filesystem", "VFS", "Inodes", "Kernel", "Performance", "OverlayFS"]
categories: ["Linux", "Systems Programming"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep dive into Linux Virtual Filesystem (VFS) layer architecture, inode structure, dentry cache, filesystem registration, file operations table, and overlayfs internals for systems programmers and DevOps engineers."
more_link: "yes"
url: "/linux-filesystem-internals-vfs-inodes-dentries/"
---

The Virtual Filesystem (VFS) is one of Linux's most elegant subsystems — a uniform abstraction layer that lets `open()`, `read()`, and `write()` work identically whether the file lives on ext4, NFS, tmpfs, or a FUSE filesystem. Understanding VFS internals helps diagnose mysterious performance issues, understand container filesystem isolation, and write kernel modules that interact with the filesystem. This guide covers the full VFS architecture: superblocks, inodes, dentries, file objects, filesystem registration, and the overlayfs implementation that powers container filesystems.

<!--more-->

# Linux Filesystem Internals: VFS, Inodes, and Dentries

## VFS Architecture Overview

```
User Space:
  open("/etc/passwd", O_RDONLY)
          │
          ▼ syscall interface
Kernel Space:
  do_sys_open()
          │
          ▼ VFS layer (fs/namei.c, fs/file.c)
  path_openat()
    │
    ├── dentry_open()     ← create file object
    │
    └── path resolution   ← walk dentry tree
          │
          ▼
  Concrete Filesystem:
  ext4_file_open()   or   nfs_file_open()   or   tmpfs_file_read_iter()
          │
          ▼
  Block Layer / Network / Memory
```

The VFS provides four key abstractions:

| Object | Kernel Struct | Purpose |
|--------|--------------|---------|
| Superblock | `struct super_block` | Mounted filesystem instance |
| Inode | `struct inode` | File metadata (permissions, size, timestamps) |
| Dentry | `struct dentry` | Directory entry (name → inode mapping) |
| File | `struct file` | Open file description (position, flags) |

## Section 1: The Superblock

A `super_block` represents a mounted filesystem instance.

### Superblock Structure (Simplified)

```c
// include/linux/fs.h (simplified)
struct super_block {
    struct list_head    s_list;           /* List of all superblocks */
    dev_t               s_dev;            /* Device identifier */
    unsigned long       s_blocksize;      /* Block size in bytes */
    loff_t              s_maxbytes;       /* Max file size */
    struct file_system_type *s_type;      /* Filesystem type */
    const struct super_operations *s_op; /* Superblock operations */
    const struct dquot_operations *dq_op; /* Quota operations */
    const struct quotactl_ops *s_qcop;
    const struct export_operations *s_export_op;
    unsigned long       s_flags;          /* Mount flags */
    unsigned long       s_iflags;         /* Internal flags */
    unsigned long       s_magic;          /* Filesystem magic number */
    struct dentry       *s_root;          /* Root dentry */
    struct rw_semaphore s_umount;         /* Unmount semaphore */
    int                 s_count;          /* Superblock ref count */
    atomic_t            s_active;         /* Active users */
    void                *s_fs_info;       /* Filesystem-private data */
    char                s_id[32];         /* Informational name */
    uuid_t              s_uuid;           /* UUID */
    unsigned int        s_max_links;      /* Max hard links */
    struct list_head    s_inodes;         /* All inodes */
    spinlock_t          s_inode_list_lock;
    struct list_head    s_inodes_wb;      /* Writeback inodes */
};
```

### Superblock Operations

```c
struct super_operations {
    struct inode *(*alloc_inode)(struct super_block *sb);
    void (*destroy_inode)(struct inode *);
    void (*dirty_inode)(struct inode *, int flags);
    int (*write_inode)(struct inode *, struct writeback_control *wbc);
    int (*drop_inode)(struct inode *);
    void (*evict_inode)(struct inode *);
    void (*put_super)(struct super_block *);
    int (*sync_fs)(struct super_block *sb, int wait);
    int (*freeze_super)(struct super_block *);
    int (*thaw_super)(struct super_block *);
    int (*statfs)(struct dentry *, struct kstatfs *);
    int (*remount_fs)(struct super_block *, int *, char *);
    void (*umount_begin)(struct super_block *);
    int (*show_options)(struct seq_file *, struct dentry *);
    int (*show_devname)(struct seq_file *, struct dentry *);
    long (*nr_cached_objects)(struct super_block *, struct shrink_control *);
    long (*free_cached_objects)(struct super_block *, struct shrink_control *);
};
```

### Examining Superblocks

```bash
# List mounted filesystems and their superblock info
cat /proc/mounts
# proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0
# sysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0
# ext4 /dev/sda1 / rw,relatime 0 0

# Get detailed filesystem statistics
stat -f /
# File: "/"
#   ID: abc123         Namelen: 255     Type: ext2/ext3
# Block size: 4096     Fundamental block size: 4096
# Blocks: Total: 20971008   Free: 15234560   Available: 14148864
# Inodes: Total: 5242880    Free: 4891234

# Check filesystem magic numbers
xxd /dev/sda1 | head -n 10  # ext4 magic: 0xEF53 at offset 0x438
python3 -c "
import struct
with open('/dev/sda1', 'rb') as f:
    f.seek(0x438)
    magic = struct.unpack('<H', f.read(2))[0]
    print(f'Magic: 0x{magic:04x}')  # Should print 0xef53 for ext4
"
```

## Section 2: The Inode

An inode stores all file metadata except the filename. The filename → inode mapping is stored in directory entries (dentries).

### Inode Structure

```c
// include/linux/fs.h (simplified)
struct inode {
    umode_t             i_mode;      /* File type and permissions (rwxrwxrwx) */
    unsigned short      i_opflags;
    kuid_t              i_uid;       /* Owner user ID */
    kgid_t              i_gid;       /* Owner group ID */
    unsigned int        i_flags;     /* Filesystem flags */
    struct posix_acl   *i_acl;       /* POSIX ACL */
    struct posix_acl   *i_default_acl;
    const struct inode_operations *i_op;  /* Inode operations */
    struct super_block *i_sb;        /* Superblock */
    struct address_space *i_mapping; /* Page cache for file data */
    unsigned long       i_ino;       /* Inode number */
    union {
        const unsigned int i_nlink;  /* Hard link count */
        unsigned int __i_nlink;
    };
    dev_t               i_rdev;      /* Real device node */
    loff_t              i_size;      /* File size in bytes */
    struct timespec64   i_atime;     /* Last access time */
    struct timespec64   i_mtime;     /* Last modification time */
    struct timespec64   i_ctime;     /* Last status change time */
    spinlock_t          i_lock;
    unsigned short      i_bytes;     /* Bytes consumed */
    u8                  i_blkbits;   /* Block size bits */
    u8                  i_write_hint;
    blkcnt_t            i_blocks;    /* Number of 512-byte blocks */
    unsigned long       i_state;     /* Inode state flags */
    atomic64_t          i_version;   /* Inode version */
    atomic_t            i_count;     /* Reference count */
    atomic_t            i_dio_count; /* Direct I/O count */
    atomic_t            i_writecount;/* Writers reference count */
    const struct file_operations *i_fop; /* Default file operations */
    struct file_lock_context *i_flctx;
    struct address_space i_data;     /* File data page cache */
    struct list_head    i_devices;   /* Block device list */
    union {
        struct pipe_inode_info *i_pipe;   /* For pipes */
        struct cdev            *i_cdev;   /* For char devices */
        char                   *i_link;  /* For symlinks */
        unsigned                i_dir_seq;
    };
    void               *i_private;   /* Filesystem-private data */
};
```

### Inode Operations

```c
struct inode_operations {
    struct dentry * (*lookup)(struct inode *, struct dentry *, unsigned int);
    const char * (*get_link)(struct dentry *, struct inode *, struct delayed_call *);
    int (*permission)(struct user_namespace *, struct inode *, int);
    struct posix_acl * (*get_acl)(struct inode *, int, bool);
    int (*readlink)(struct dentry *, char __user *, int);
    int (*create)(struct user_namespace *, struct inode *, struct dentry *, umode_t, bool);
    int (*link)(struct dentry *, struct inode *, struct dentry *);
    int (*unlink)(struct inode *, struct dentry *);
    int (*symlink)(struct user_namespace *, struct inode *, struct dentry *, const char *);
    int (*mkdir)(struct user_namespace *, struct inode *, struct dentry *, umode_t);
    int (*rmdir)(struct inode *, struct dentry *);
    int (*mknod)(struct user_namespace *, struct inode *, struct dentry *, umode_t, dev_t);
    int (*rename)(struct user_namespace *, struct inode *, struct dentry *,
                  struct inode *, struct dentry *, unsigned int);
    int (*setattr)(struct user_namespace *, struct dentry *, struct iattr *);
    int (*getattr)(struct user_namespace *, const struct path *, struct kstat *, u32, unsigned int);
    ssize_t (*listxattr)(struct dentry *, char *, size_t);
    int (*fiemap)(struct inode *, struct fiemap_extent_info *, u64 start, u64 len);
    int (*update_time)(struct inode *, struct timespec64 *, int);
    int (*atomic_open)(struct inode *, struct dentry *, struct file *, unsigned open_flag,
                       umode_t create_mode);
    int (*tmpfile)(struct user_namespace *, struct inode *, struct file *, umode_t);
    int (*set_acl)(struct user_namespace *, struct inode *, struct posix_acl *, int);
    int (*fileattr_set)(struct user_namespace *, struct dentry *, struct fileattr *);
    int (*fileattr_get)(struct dentry *, struct fileattr *);
};
```

### Working with Inodes from User Space

```bash
# View inode number for a file
ls -i /etc/passwd
# 2359297 /etc/passwd

# stat shows all inode fields
stat /etc/passwd
# File: /etc/passwd
# Size: 2345        Blocks: 8          IO Block: 4096   regular file
# Device: 8,1       Inode: 2359297     Links: 1
# Access: (0644/-rw-r--r--)  Uid: (0/ root)   Gid: (0/ root)
# Access: 2029-05-21 10:23:45.123456789 +0000
# Modify: 2029-05-20 15:30:12.987654321 +0000
# Change: 2029-05-20 15:30:12.987654321 +0000
# Birth:  2029-01-15 08:00:00.000000000 +0000

# Find file by inode number (useful after deletion for recovery)
find / -inum 2359297 2>/dev/null

# Check inode usage
df -i /
# Filesystem     Inodes IUsed  IFree IUse% Mounted on
# /dev/sda1     5242880 89234 5153646    2% /

# Show hard links (files with same inode)
find /usr/bin -type f | while read f; do
    echo "$(stat -c '%i' "$f") $f"
done | sort -n | awk '
    {
        if ($1 == prev_inode) print "HARDLINK: " $0
        prev_inode = $1
    }'
```

### Inode Cache Statistics

```bash
# Check inode cache (slab allocator)
cat /proc/slabinfo | grep -E "^inode|^dentry"
# slab name           <active_objs> <num_objs> <objsize> <objperslab> <pagesperslab>
# ext4_inode_cache    45231          48000       960       8             2
# inode_cache         12043          13000       576       7             1
# dentry              89234          90000       192      21             1

# More readable via slabtop
slabtop -o | head -30

# Tune inode/dentry cache pressure
cat /proc/sys/vm/vfs_cache_pressure
# 100 = default, lower = keep more inodes/dentries cached

# For servers with lots of RAM and many small files:
echo 50 > /proc/sys/vm/vfs_cache_pressure
```

## Section 3: The Dentry Cache

Dentries (directory entries) map filenames to inodes. The dentry cache (dcache) is one of Linux's most important performance structures.

### Dentry Structure

```c
// include/linux/dcache.h (simplified)
struct dentry {
    unsigned int        d_flags;         /* Protected by d_lock */
    seqcount_spinlock_t d_seq;           /* Per-dentry seqlock */
    struct hlist_bl_node d_hash;         /* Lookup hash list */
    struct dentry       *d_parent;       /* Parent directory */
    struct qstr         d_name;          /* Filename + hash */
    struct inode        *d_inode;        /* Inode (NULL if negative dentry) */
    unsigned char       d_iname[DNAME_INLINE_LEN]; /* Small name optimization */
    const struct dentry_operations *d_op;
    struct super_block  *d_sb;           /* Root of the tree */
    unsigned long       d_time;          /* Used by d_revalidate */
    void                *d_fsdata;       /* Filesystem-specific data */
    union {
        struct list_head    d_lru;        /* LRU list */
        wait_queue_head_t  *d_wait;       /* In-lookup wait queue */
    };
    struct list_head    d_child;         /* Child of parent list */
    struct list_head    d_subdirs;       /* Our children */
    union {
        struct hlist_node   d_alias;     /* Inode alias list */
        struct hlist_bl_node d_in_lookup_hash;
        struct rcu_head     d_rcu;
    } d_u;
};
```

### Negative Dentries

A "negative dentry" records that a filename does not exist. This is critical for performance:

```bash
# Without negative dentries, this would need to hit disk every time:
ls /etc/nonexistent_file
# ls: cannot access '/etc/nonexistent_file': No such file or directory

# The kernel caches "nonexistent_file doesn't exist" as a negative dentry
# Subsequent lookups are served from the cache

# See negative dentry stats
cat /proc/sys/fs/dentry-state
# 123456 89234 45 0 0 0
# nr_dentry  nr_unused  age_limit  want_pages  nr_negative  nr_unused_negative
```

### Dentry Operations

```c
struct dentry_operations {
    int (*d_revalidate)(struct dentry *, unsigned int);
    int (*d_weak_revalidate)(struct dentry *, unsigned int);
    int (*d_hash)(const struct dentry *, struct qstr *);
    int (*d_compare)(const struct dentry *, unsigned int, const char *, const struct qstr *);
    int (*d_delete)(const struct dentry *);
    int (*d_init)(struct dentry *);
    void (*d_release)(struct dentry *);
    void (*d_prune)(struct dentry *);
    void (*d_iput)(struct dentry *, struct inode *);
    char *(*d_dname)(struct dentry *, char *, int);
    struct vfsmount *(*d_automount)(struct path *);
    int (*d_manage)(const struct path *, bool);
    struct dentry *(*d_real)(struct dentry *, const struct inode *);
};
```

### Path Resolution Performance

```bash
# Measure path resolution overhead
strace -c stat /usr/bin/ls 2>&1 | grep -E "^total|stat"

# For a filesystem stress test:
# Create many directories to stress the dentry cache
mkdir -p /tmp/dentry_test
for i in $(seq 1 10000); do
    mkdir -p "/tmp/dentry_test/level1/level2/level3/dir${i}"
done

# Benchmark path resolution
time ls /tmp/dentry_test/level1/level2/level3/ > /dev/null

# Warm the dentry cache
find /tmp/dentry_test -maxdepth 5 -type d > /dev/null

# Benchmark again — should be faster
time ls /tmp/dentry_test/level1/level2/level3/ > /dev/null

# Clean up
rm -rf /tmp/dentry_test
```

## Section 4: The File Object

A `struct file` is created when a file descriptor is opened. Multiple file objects can point to the same inode.

### File Structure

```c
// include/linux/fs.h (simplified)
struct file {
    union {
        struct llist_node   f_llist;
        struct rcu_head     f_rcuhead;
        unsigned int        f_iocb_flags;
    };
    struct path             f_path;          /* Dentry + vfsmount */
    struct inode            *f_inode;        /* Cached inode */
    const struct file_operations *f_op;      /* File operations */
    spinlock_t              f_lock;
    atomic_long_t           f_count;         /* Reference count */
    unsigned int            f_flags;         /* O_RDONLY etc */
    fmode_t                 f_mode;          /* FMODE_READ etc */
    struct mutex            f_pos_lock;
    loff_t                  f_pos;           /* Current file position */
    struct fown_struct      f_owner;         /* For async I/O */
    const struct cred       *f_cred;         /* Opener's credentials */
    struct file_ra_state    f_ra;            /* Read-ahead state */
    u64                     f_version;
    void                    *f_security;     /* LSM security */
    void                    *private_data;   /* tty, socket, etc */
    struct address_space    *f_mapping;      /* Page cache */
    errseq_t                f_wb_err;        /* Writeback error */
    errseq_t                f_sb_err;        /* Superblock error */
};
```

### File Operations Table

This is the key interface between VFS and concrete filesystems:

```c
struct file_operations {
    struct module *owner;
    loff_t (*llseek)(struct file *, loff_t, int);
    ssize_t (*read)(struct file *, char __user *, size_t, loff_t *);
    ssize_t (*write)(struct file *, const char __user *, size_t, loff_t *);
    ssize_t (*read_iter)(struct kiocb *, struct iov_iter *);
    ssize_t (*write_iter)(struct kiocb *, struct iov_iter *);
    int (*iopoll)(struct kiocb *kiocb, struct io_comp_batch *, unsigned int flags);
    int (*iterate_shared)(struct file *, struct dir_context *);
    __poll_t (*poll)(struct file *, struct poll_table_struct *);
    long (*unlocked_ioctl)(struct file *, unsigned int, unsigned long);
    long (*compat_ioctl)(struct file *, unsigned int, unsigned long);
    int (*mmap)(struct file *, struct vm_area_struct *);
    unsigned long mmap_supported_flags;
    int (*open)(struct inode *, struct file *);
    int (*flush)(struct file *, fl_owner_t id);
    int (*release)(struct inode *, struct file *);
    int (*fsync)(struct file *, loff_t, loff_t, int datasync);
    int (*fasync)(int, struct file *, int);
    int (*lock)(struct file *, int, struct file_lock *);
    ssize_t (*sendfile)(struct file *, loff_t *, size_t, read_actor_t, void *);
    ssize_t (*sendpage)(struct file *, struct page *, int, size_t, loff_t *, int);
    unsigned long (*get_unmapped_area)(struct file *, unsigned long, unsigned long,
                                       unsigned long, unsigned long);
    int (*check_flags)(int);
    int (*flock)(struct file *, int, struct file_lock *);
    ssize_t (*splice_write)(struct pipe_inode_info *, struct file *,
                             loff_t *, size_t, unsigned int);
    ssize_t (*splice_read)(struct file *, loff_t *, struct pipe_inode_info *,
                            size_t, unsigned int);
    int (*setlease)(struct file *, long, struct file_lock **, void **);
    long (*fallocate)(struct file *file, int mode, loff_t offset, loff_t len);
    void (*show_fdinfo)(struct seq_file *m, struct file *f);
    ssize_t (*copy_file_range)(struct file *, loff_t, struct file *, loff_t,
                                size_t, unsigned int);
    loff_t (*remap_file_range)(struct file *file_in, loff_t pos_in,
                                struct file *file_out, loff_t pos_out,
                                loff_t len, unsigned int remap_flags);
    int (*fadvise)(struct file *, loff_t, loff_t, int);
    int (*uring_cmd)(struct io_uring_cmd *ioucmd, unsigned int issue_flags);
    int (*uring_cmd_iopoll)(struct io_uring_cmd *, struct io_comp_batch *, unsigned int poll_flags);
};
```

## Section 5: Filesystem Registration

Filesystems register themselves with the VFS kernel subsystem at module load time.

### Registering a Filesystem Type

```c
// A custom filesystem module (simplified)
#include <linux/module.h>
#include <linux/fs.h>
#include <linux/init.h>

#define MYFS_MAGIC 0xDEADBEEF

static struct inode *myfs_make_inode(struct super_block *sb, int mode) {
    struct inode *ret = new_inode(sb);
    if (ret) {
        inode_init_owner(&init_user_ns, ret, NULL, mode);
        ret->i_blocks = 0;
        ret->i_atime = ret->i_mtime = ret->i_ctime = current_time(ret);
    }
    return ret;
}

static int myfs_fill_super(struct super_block *sb, void *data, int silent) {
    struct inode *root;

    sb->s_blocksize = PAGE_SIZE;
    sb->s_blocksize_bits = PAGE_SHIFT;
    sb->s_magic = MYFS_MAGIC;
    sb->s_op = &myfs_super_operations;

    root = myfs_make_inode(sb, S_IFDIR | 0755);
    if (!root)
        return -ENOMEM;

    root->i_op = &simple_dir_inode_operations;
    root->i_fop = &simple_dir_operations;

    sb->s_root = d_make_root(root);
    if (!sb->s_root) {
        iput(root);
        return -ENOMEM;
    }

    return 0;
}

static struct dentry *myfs_mount(struct file_system_type *fs_type,
                                  int flags, const char *dev_name, void *data) {
    return mount_nodev(fs_type, flags, data, myfs_fill_super);
}

static struct file_system_type myfs_type = {
    .owner      = THIS_MODULE,
    .name       = "myfs",
    .mount      = myfs_mount,
    .kill_sb    = kill_litter_super,
};

static int __init myfs_init(void) {
    return register_filesystem(&myfs_type);
}

static void __exit myfs_exit(void) {
    unregister_filesystem(&myfs_type);
}

module_init(myfs_init);
module_exit(myfs_exit);
MODULE_LICENSE("GPL");
MODULE_AUTHOR("Example");
MODULE_DESCRIPTION("Minimal Example Filesystem");
```

### Listing Registered Filesystems

```bash
# See all registered filesystems
cat /proc/filesystems
# nodev  sysfs
# nodev  tmpfs
# nodev  bdev
# nodev  proc
# nodev  cgroup
# nodev  cgroup2
# nodev  devtmpfs
# nodev  binfmt_misc
# nodev  configfs
# nodev  debugfs
# nodev  tracefs
# nodev  securityfs
# nodev  sockfs
# nodev  bpf
# nodev  pipefs
# nodev  hugetlbfs
# nodev  devpts
#        ext3
#        ext2
#        ext4
#        squashfs
#        vfat
#        btrfs
#        xfs
# nodev  fuse
# nodev  fusectl
# nodev  overlay  ← overlayfs for containers

# "nodev" means the filesystem doesn't require a block device
```

## Section 6: OverlayFS Internals

OverlayFS is the filesystem that powers Docker and container runtimes. Understanding it explains why containers are fast and what their performance characteristics are.

### OverlayFS Architecture

```
Container Layer (upperdir):  /var/lib/docker/overlay2/abc123/diff
                    │
                    ▼
    ┌───────────────────────────────────────┐
    │           OverlayFS                   │
    │  Merged view = upper + lower          │
    │                                       │
    │  Read: upperdir first, then lowerdir  │
    │  Write: always to upperdir            │
    │  Delete: create whiteout file in upper│
    └───────────────────────────────────────┘
                    │
                    ▼
Image Layers (lowerdir):  /var/lib/docker/overlay2/layer1:layer2:layer3
```

### OverlayFS Mount

```bash
# Manual overlayfs mount
mkdir -p /tmp/overlay/{upper,work,merged,lower}

# Populate lower layer (read-only base)
echo "base file" > /tmp/overlay/lower/base.txt
echo "shared config" > /tmp/overlay/lower/config.txt

# Mount overlay
mount -t overlay overlay \
  -o lowerdir=/tmp/overlay/lower,\
upperdir=/tmp/overlay/upper,\
workdir=/tmp/overlay/work \
  /tmp/overlay/merged

# Now test operations:
ls /tmp/overlay/merged/
# base.txt  config.txt

# Write creates file in upper (copy-on-write)
echo "new content" > /tmp/overlay/merged/new_file.txt
ls /tmp/overlay/upper/
# new_file.txt  (only in upper)
ls /tmp/overlay/lower/
# base.txt  config.txt  (unchanged)

# Modify a lower file — triggers CoW
echo "modified" > /tmp/overlay/merged/base.txt
ls /tmp/overlay/upper/
# base.txt  new_file.txt  (base.txt copied to upper then modified)
ls /tmp/overlay/lower/
# base.txt  config.txt  (lower is unmodified)

# Delete creates a "whiteout" device file
rm /tmp/overlay/merged/config.txt
ls -la /tmp/overlay/upper/
# c--------- 1 root root 0, 0 May 23 10:00 config.txt  ← whiteout char device 0:0

# Unmount
umount /tmp/overlay/merged
```

### How Docker Uses OverlayFS

```bash
# Inspect a running container's overlay mounts
CONTAINER_ID="my-container-name"
docker inspect ${CONTAINER_ID} | jq '.[0].GraphDriver'
# {
#   "Data": {
#     "LowerDir": "/var/lib/docker/overlay2/abc123-init/diff:
#                  /var/lib/docker/overlay2/def456/diff:
#                  /var/lib/docker/overlay2/ghi789/diff",
#     "MergedDir": "/var/lib/docker/overlay2/abc123/merged",
#     "UpperDir": "/var/lib/docker/overlay2/abc123/diff",
#     "WorkDir": "/var/lib/docker/overlay2/abc123/work"
#   },
#   "Name": "overlay2"
# }

# See the actual overlay mount
cat /proc/mounts | grep overlay
# overlay /var/lib/docker/overlay2/abc123/merged overlay
#   rw,relatime,lowerdir=/var/lib/docker/overlay2/def456/diff:...,
#   upperdir=/var/lib/docker/overlay2/abc123/diff,
#   workdir=/var/lib/docker/overlay2/abc123/work

# Check how many layers a container has
docker history nginx:latest | wc -l
```

### OverlayFS Performance Considerations

```bash
# Check inode usage in overlayfs (critical for many small files)
df -i /var/lib/docker
# Filesystem      Inodes  IUsed   IFree IUse% Mounted on
# /dev/sda1      5242880 2845234 2397646   55% /var/lib/docker

# The "d_type" check — overlayfs requires d_type support
# Check if underlying filesystem supports it
tune2fs -l /dev/sda1 | grep features | grep dir_index
# Or check with:
docker info | grep "Backing Filesystem"
docker info | grep "Supports d_type"
# WARNING: overlay2: the backing xfs filesystem is formatted without d_type support

# Optimize for container workloads — increase inode counts on mkfs
# For ext4:
mkfs.ext4 -N 10000000 /dev/sdb1  # 10M inodes
# For xfs with ftype=1 (required for overlayfs):
mkfs.xfs -n ftype=1 /dev/sdb1
```

## Section 7: Special Filesystems

### proc Filesystem

```bash
# /proc is entirely in-memory, generated on-demand
# Its implementation uses seq_file to generate content lazily

# See what kernel structures are exposed
ls /proc/
# 1 2 3 ... (process directories)
# acpi  buddyinfo  bus  cmdline  cpuinfo  crypto  devices
# diskstats  dma  driver  execdomains  filesystems  fs
# interrupts  iomem  ioports  irq  kallsyms  kcore  keys
# kmsg  kpagecount  kpageflags  loadavg  locks  mdstat
# meminfo  misc  modules  mounts  mtrr  net  pagetypeinfo
# partitions  schedstat  scsi  self  slabinfo  softirqs
# stat  swaps  sys  sysrq-trigger  sysvipc  thread-self  timer_list
# tty  uptime  version  vmallocinfo  vmstat  zoneinfo

# Read raw kernel memory stats
cat /proc/meminfo

# See kernel module list
cat /proc/modules | head -5

# See all running processes with their virtual memory maps
cat /proc/1/maps | head -10
```

### tmpfs Internals

```bash
# tmpfs uses pagecache directly — no disk backing
# Data lives in RAM and is lost on unmount

# Create a tmpfs with size limits
mount -t tmpfs -o size=512m,nr_inodes=100000 tmpfs /mnt/tmpfs

# Check tmpfs mount options
cat /proc/mounts | grep tmpfs
# tmpfs /run tmpfs rw,nosuid,nodev,noexec,relatime,size=819200k,mode=755 0 0
# tmpfs /dev/shm tmpfs rw,nosuid,nodev,relatime 0 0

# tmpfs supports swap-backed pages (hugetlbfs does not)
# For performance-critical tmpfs (e.g., pod emptyDir):
mount -t tmpfs -o size=4g,huge=always tmpfs /mnt/huge_tmpfs
```

## Section 8: VFS Tracing with bpftrace

```bash
# Trace all open() syscalls
bpftrace -e 'tracepoint:syscalls:sys_enter_openat {
    printf("%d %s %s\n", pid, comm, str(args->filename));
}'

# Trace VFS read operations with latency
bpftrace -e '
kprobe:vfs_read {
    @start[tid] = nsecs;
}
kretprobe:vfs_read /retval > 0 && @start[tid]/ {
    @latency_us = hist((nsecs - @start[tid]) / 1000);
    delete(@start[tid]);
}'

# Trace dentry cache miss rate
bpftrace -e '
kprobe:d_lookup_real {
    @lookups = count();
}
kretprobe:d_lookup_real /!retval/ {
    @misses = count();
}
interval:s:1 {
    printf("lookups: %d, misses: %d, miss_rate: %d%%\n",
        @lookups, @misses,
        @lookups > 0 ? 100 * @misses / @lookups : 0);
    clear(@lookups);
    clear(@misses);
}'

# Trace inode evictions (can indicate inode cache pressure)
bpftrace -e 'kprobe:evict_inode {
    @evictions[kstack] = count();
}
END { print(@evictions, 5); }'
```

## Section 9: Performance Tuning Summary

```bash
# /etc/sysctl.d/99-vfs-performance.conf

# Reduce VFS cache eviction pressure (keep more dentries/inodes cached)
# Lower = less aggressive eviction, higher = more aggressive
vm.vfs_cache_pressure = 50

# Increase inotify limits (for file watchers like CI/CD agents)
fs.inotify.max_user_watches = 524288
fs.inotify.max_user_instances = 512

# Increase file descriptor limits
fs.file-max = 2097152

# Writeback tuning
vm.dirty_ratio = 15            # % of RAM that can be dirty before blocking writes
vm.dirty_background_ratio = 5  # % of RAM that triggers background writeback
vm.dirty_expire_centisecs = 3000  # How old dirty data can get (30 seconds)
vm.dirty_writeback_centisecs = 500  # How often to run writeback (5 seconds)

# For NFS clients: disable atime updates to reduce write traffic
# Mount with: mount -o noatime,nodiratime ...
# Or set globally:
# vm.dirtytime_expire_seconds = 43200
```

```bash
# Apply
sysctl -p /etc/sysctl.d/99-vfs-performance.conf

# Monitor VFS performance
watch -n 1 'cat /proc/sys/fs/dentry-state && cat /proc/sys/fs/inode-state'

# Check for inode exhaustion
df -i | awk '$5 > 80 {print "WARNING: inode usage >80%:", $0}'
```

## Conclusion

The VFS layer is one of Linux's most sophisticated subsystems. Its clean interface — superblocks, inodes, dentries, and file objects — allows hundreds of different filesystem implementations to coexist transparently. For practitioners, the most important takeaways are: the dentry cache is critical for path lookup performance and should be sized generously; inode exhaustion can take down a filesystem even when blocks remain; and overlayfs's copy-on-write semantics explain both the efficiency and the limitations of container storage. Understanding these internals enables smarter configuration, better performance diagnosis, and safer filesystem operations in production.
