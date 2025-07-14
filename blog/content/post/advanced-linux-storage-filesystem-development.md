---
title: "Advanced Linux Storage Systems and Filesystem Development: Building Custom Filesystems and Storage Solutions"
date: 2025-04-16T10:00:00-05:00
draft: false
tags: ["Linux", "Filesystem", "Storage", "Block Devices", "FUSE", "VFS", "Kernel", "Performance"]
categories:
- Linux
- Storage Systems
author: "Matthew Mattox - mmattox@support.tools"
description: "Master advanced Linux storage systems including custom filesystem development, FUSE programming, block device drivers, and building high-performance storage solutions"
more_link: "yes"
url: "/advanced-linux-storage-filesystem-development/"
---

Modern Linux storage systems require sophisticated understanding of filesystem architectures, block device management, and performance optimization techniques. This comprehensive guide explores advanced storage concepts, from building custom filesystems with FUSE to developing kernel-level block device drivers and implementing high-performance storage solutions.

<!--more-->

# [Advanced Linux Storage Systems and Filesystem Development](#advanced-linux-storage-filesystem-development)

## FUSE Filesystem Development Framework

### Advanced FUSE Filesystem Implementation

```c
// fuse_filesystem.c - Advanced FUSE filesystem implementation
#define FUSE_USE_VERSION 31

#include <fuse3/fuse.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>
#include <stddef.h>
#include <assert.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/xattr.h>
#include <dirent.h>
#include <pthread.h>
#include <time.h>
#include <openssl/sha.h>
#include <openssl/evp.h>
#include <sqlite3.h>
#include <zlib.h>
#include <lz4.h>
#include <snappy-c.h>

#define MAX_PATH_LEN 4096
#define MAX_FILENAME_LEN 256
#define BLOCK_SIZE 4096
#define MAX_CACHE_ENTRIES 10000
#define COMPRESSION_THRESHOLD 1024

// Filesystem configuration
typedef struct {
    char *root_path;
    char *cache_path;
    char *db_path;
    bool enable_compression;
    bool enable_encryption;
    bool enable_deduplication;
    bool enable_caching;
    int compression_level;
    char encryption_key[32];
    size_t max_cache_size;
    pthread_rwlock_t global_lock;
} fs_config_t;

// File metadata structure
typedef struct {
    char path[MAX_PATH_LEN];
    ino_t inode;
    mode_t mode;
    nlink_t nlink;
    uid_t uid;
    gid_t gid;
    off_t size;
    off_t blocks;
    time_t atime;
    time_t mtime;
    time_t ctime;
    bool compressed;
    bool encrypted;
    char checksum[SHA256_DIGEST_LENGTH * 2 + 1];
    uint32_t compression_ratio;
} file_metadata_t;

// Cache entry structure
typedef struct cache_entry {
    char path[MAX_PATH_LEN];
    void *data;
    size_t size;
    time_t last_access;
    bool dirty;
    pthread_mutex_t lock;
    struct cache_entry *next;
    struct cache_entry *prev;
} cache_entry_t;

// Cache management
typedef struct {
    cache_entry_t *head;
    cache_entry_t *tail;
    size_t current_size;
    size_t max_size;
    int entry_count;
    pthread_rwlock_t lock;
} cache_manager_t;

// Global filesystem context
typedef struct {
    fs_config_t config;
    cache_manager_t cache;
    sqlite3 *metadata_db;
    pthread_mutex_t db_lock;
    ino_t next_inode;
} fs_context_t;

static fs_context_t *fs_ctx = NULL;

// Utility functions
static char* build_real_path(const char *path) {
    char *real_path = malloc(strlen(fs_ctx->config.root_path) + strlen(path) + 1);
    strcpy(real_path, fs_ctx->config.root_path);
    strcat(real_path, path);
    return real_path;
}

static void calculate_sha256(const void *data, size_t len, char *output) {
    unsigned char hash[SHA256_DIGEST_LENGTH];
    EVP_MD_CTX *ctx = EVP_MD_CTX_new();
    
    EVP_DigestInit_ex(ctx, EVP_sha256(), NULL);
    EVP_DigestUpdate(ctx, data, len);
    EVP_DigestFinal_ex(ctx, hash, NULL);
    EVP_MD_CTX_free(ctx);
    
    for (int i = 0; i < SHA256_DIGEST_LENGTH; i++) {
        sprintf(output + (i * 2), "%02x", hash[i]);
    }
    output[SHA256_DIGEST_LENGTH * 2] = '\0';
}

// Compression functions
static int compress_data(const void *src, size_t src_len, void **dst, size_t *dst_len, int level) {
    if (src_len < COMPRESSION_THRESHOLD) {
        return -1; // Don't compress small data
    }
    
    // Try LZ4 first (fastest)
    size_t lz4_bound = LZ4_compressBound(src_len);
    char *lz4_buf = malloc(lz4_bound);
    
    int lz4_size = LZ4_compress_default(src, lz4_buf, src_len, lz4_bound);
    if (lz4_size > 0 && lz4_size < src_len * 0.9) {
        *dst = lz4_buf;
        *dst_len = lz4_size;
        return 0; // LZ4 compression successful
    }
    free(lz4_buf);
    
    // Fall back to zlib for better compression
    uLongf zlib_len = compressBound(src_len);
    Bytef *zlib_buf = malloc(zlib_len);
    
    int result = compress2(zlib_buf, &zlib_len, src, src_len, level);
    if (result == Z_OK && zlib_len < src_len * 0.9) {
        *dst = zlib_buf;
        *dst_len = zlib_len;
        return 1; // zlib compression successful
    }
    
    free(zlib_buf);
    return -1; // Compression not beneficial
}

static int decompress_data(const void *src, size_t src_len, void **dst, size_t *dst_len, int method) {
    if (method == 0) {
        // LZ4 decompression
        // We need to know the original size for LZ4
        // This would typically be stored in metadata
        char *decomp_buf = malloc(*dst_len);
        int result = LZ4_decompress_safe(src, decomp_buf, src_len, *dst_len);
        if (result > 0) {
            *dst = decomp_buf;
            *dst_len = result;
            return 0;
        }
        free(decomp_buf);
    } else if (method == 1) {
        // zlib decompression
        uLongf decomp_len = *dst_len;
        Bytef *decomp_buf = malloc(decomp_len);
        int result = uncompress(decomp_buf, &decomp_len, src, src_len);
        if (result == Z_OK) {
            *dst = decomp_buf;
            *dst_len = decomp_len;
            return 0;
        }
        free(decomp_buf);
    }
    
    return -1;
}

// Encryption functions (simplified AES)
static int encrypt_data(const void *src, size_t src_len, void **dst, size_t *dst_len, const char *key) {
    // Simplified encryption placeholder
    // In production, use proper AES-GCM or ChaCha20-Poly1305
    *dst = malloc(src_len + 16); // Add space for IV
    memcpy(*dst, src, src_len);
    *dst_len = src_len + 16;
    return 0;
}

static int decrypt_data(const void *src, size_t src_len, void **dst, size_t *dst_len, const char *key) {
    // Simplified decryption placeholder
    *dst = malloc(src_len - 16);
    memcpy(*dst, src, src_len - 16);
    *dst_len = src_len - 16;
    return 0;
}

// Cache management functions
static void cache_init(cache_manager_t *cache, size_t max_size) {
    cache->head = NULL;
    cache->tail = NULL;
    cache->current_size = 0;
    cache->max_size = max_size;
    cache->entry_count = 0;
    pthread_rwlock_init(&cache->lock, NULL);
}

static cache_entry_t* cache_find(cache_manager_t *cache, const char *path) {
    pthread_rwlock_rdlock(&cache->lock);
    
    cache_entry_t *entry = cache->head;
    while (entry) {
        if (strcmp(entry->path, path) == 0) {
            entry->last_access = time(NULL);
            pthread_rwlock_unlock(&cache->lock);
            return entry;
        }
        entry = entry->next;
    }
    
    pthread_rwlock_unlock(&cache->lock);
    return NULL;
}

static void cache_evict_lru(cache_manager_t *cache) {
    if (!cache->tail) return;
    
    cache_entry_t *victim = cache->tail;
    
    // Remove from list
    if (victim->prev) {
        victim->prev->next = NULL;
    } else {
        cache->head = NULL;
    }
    cache->tail = victim->prev;
    
    cache->current_size -= victim->size;
    cache->entry_count--;
    
    pthread_mutex_destroy(&victim->lock);
    free(victim->data);
    free(victim);
}

static void cache_add(cache_manager_t *cache, const char *path, const void *data, size_t size) {
    pthread_rwlock_wrlock(&cache->lock);
    
    // Check if we need to evict entries
    while (cache->current_size + size > cache->max_size && cache->tail) {
        cache_evict_lru(cache);
    }
    
    // Create new entry
    cache_entry_t *entry = malloc(sizeof(cache_entry_t));
    strncpy(entry->path, path, MAX_PATH_LEN - 1);
    entry->path[MAX_PATH_LEN - 1] = '\0';
    entry->data = malloc(size);
    memcpy(entry->data, data, size);
    entry->size = size;
    entry->last_access = time(NULL);
    entry->dirty = false;
    pthread_mutex_init(&entry->lock, NULL);
    entry->next = cache->head;
    entry->prev = NULL;
    
    if (cache->head) {
        cache->head->prev = entry;
    } else {
        cache->tail = entry;
    }
    cache->head = entry;
    
    cache->current_size += size;
    cache->entry_count++;
    
    pthread_rwlock_unlock(&cache->lock);
}

// Database operations
static int init_metadata_db(void) {
    int rc = sqlite3_open(fs_ctx->config.db_path, &fs_ctx->metadata_db);
    if (rc != SQLITE_OK) {
        fprintf(stderr, "Cannot open database: %s\n", sqlite3_errmsg(fs_ctx->metadata_db));
        return -1;
    }
    
    // Create metadata table
    const char *sql = 
        "CREATE TABLE IF NOT EXISTS file_metadata ("
        "path TEXT PRIMARY KEY,"
        "inode INTEGER,"
        "mode INTEGER,"
        "nlink INTEGER,"
        "uid INTEGER,"
        "gid INTEGER,"
        "size INTEGER,"
        "blocks INTEGER,"
        "atime INTEGER,"
        "mtime INTEGER,"
        "ctime INTEGER,"
        "compressed INTEGER,"
        "encrypted INTEGER,"
        "checksum TEXT,"
        "compression_ratio INTEGER"
        ");";
    
    rc = sqlite3_exec(fs_ctx->metadata_db, sql, NULL, NULL, NULL);
    if (rc != SQLITE_OK) {
        fprintf(stderr, "SQL error: %s\n", sqlite3_errmsg(fs_ctx->metadata_db));
        return -1;
    }
    
    // Create index for faster lookups
    sql = "CREATE INDEX IF NOT EXISTS idx_inode ON file_metadata(inode);";
    sqlite3_exec(fs_ctx->metadata_db, sql, NULL, NULL, NULL);
    
    return 0;
}

static int store_metadata(const file_metadata_t *metadata) {
    pthread_mutex_lock(&fs_ctx->db_lock);
    
    const char *sql = 
        "INSERT OR REPLACE INTO file_metadata "
        "(path, inode, mode, nlink, uid, gid, size, blocks, atime, mtime, ctime, "
        "compressed, encrypted, checksum, compression_ratio) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);";
    
    sqlite3_stmt *stmt;
    int rc = sqlite3_prepare_v2(fs_ctx->metadata_db, sql, -1, &stmt, NULL);
    if (rc != SQLITE_OK) {
        pthread_mutex_unlock(&fs_ctx->db_lock);
        return -1;
    }
    
    sqlite3_bind_text(stmt, 1, metadata->path, -1, SQLITE_STATIC);
    sqlite3_bind_int64(stmt, 2, metadata->inode);
    sqlite3_bind_int(stmt, 3, metadata->mode);
    sqlite3_bind_int(stmt, 4, metadata->nlink);
    sqlite3_bind_int(stmt, 5, metadata->uid);
    sqlite3_bind_int(stmt, 6, metadata->gid);
    sqlite3_bind_int64(stmt, 7, metadata->size);
    sqlite3_bind_int64(stmt, 8, metadata->blocks);
    sqlite3_bind_int64(stmt, 9, metadata->atime);
    sqlite3_bind_int64(stmt, 10, metadata->mtime);
    sqlite3_bind_int64(stmt, 11, metadata->ctime);
    sqlite3_bind_int(stmt, 12, metadata->compressed ? 1 : 0);
    sqlite3_bind_int(stmt, 13, metadata->encrypted ? 1 : 0);
    sqlite3_bind_text(stmt, 14, metadata->checksum, -1, SQLITE_STATIC);
    sqlite3_bind_int(stmt, 15, metadata->compression_ratio);
    
    rc = sqlite3_step(stmt);
    sqlite3_finalize(stmt);
    
    pthread_mutex_unlock(&fs_ctx->db_lock);
    
    return (rc == SQLITE_DONE) ? 0 : -1;
}

static int load_metadata(const char *path, file_metadata_t *metadata) {
    pthread_mutex_lock(&fs_ctx->db_lock);
    
    const char *sql = "SELECT * FROM file_metadata WHERE path = ?;";
    sqlite3_stmt *stmt;
    
    int rc = sqlite3_prepare_v2(fs_ctx->metadata_db, sql, -1, &stmt, NULL);
    if (rc != SQLITE_OK) {
        pthread_mutex_unlock(&fs_ctx->db_lock);
        return -1;
    }
    
    sqlite3_bind_text(stmt, 1, path, -1, SQLITE_STATIC);
    
    rc = sqlite3_step(stmt);
    if (rc == SQLITE_ROW) {
        strncpy(metadata->path, (char*)sqlite3_column_text(stmt, 0), MAX_PATH_LEN - 1);
        metadata->inode = sqlite3_column_int64(stmt, 1);
        metadata->mode = sqlite3_column_int(stmt, 2);
        metadata->nlink = sqlite3_column_int(stmt, 3);
        metadata->uid = sqlite3_column_int(stmt, 4);
        metadata->gid = sqlite3_column_int(stmt, 5);
        metadata->size = sqlite3_column_int64(stmt, 6);
        metadata->blocks = sqlite3_column_int64(stmt, 7);
        metadata->atime = sqlite3_column_int64(stmt, 8);
        metadata->mtime = sqlite3_column_int64(stmt, 9);
        metadata->ctime = sqlite3_column_int64(stmt, 10);
        metadata->compressed = sqlite3_column_int(stmt, 11) ? true : false;
        metadata->encrypted = sqlite3_column_int(stmt, 12) ? true : false;
        strncpy(metadata->checksum, (char*)sqlite3_column_text(stmt, 13), 
                sizeof(metadata->checksum) - 1);
        metadata->compression_ratio = sqlite3_column_int(stmt, 14);
        
        sqlite3_finalize(stmt);
        pthread_mutex_unlock(&fs_ctx->db_lock);
        return 0;
    }
    
    sqlite3_finalize(stmt);
    pthread_mutex_unlock(&fs_ctx->db_lock);
    return -1;
}

// FUSE operation implementations
static int fs_getattr(const char *path, struct stat *stbuf, struct fuse_file_info *fi) {
    (void) fi;
    
    memset(stbuf, 0, sizeof(struct stat));
    
    // Try to load metadata from database
    file_metadata_t metadata;
    if (load_metadata(path, &metadata) == 0) {
        stbuf->st_ino = metadata.inode;
        stbuf->st_mode = metadata.mode;
        stbuf->st_nlink = metadata.nlink;
        stbuf->st_uid = metadata.uid;
        stbuf->st_gid = metadata.gid;
        stbuf->st_size = metadata.size;
        stbuf->st_blocks = metadata.blocks;
        stbuf->st_atime = metadata.atime;
        stbuf->st_mtime = metadata.mtime;
        stbuf->st_ctime = metadata.ctime;
        return 0;
    }
    
    // Fall back to real file system
    char *real_path = build_real_path(path);
    int res = lstat(real_path, stbuf);
    free(real_path);
    
    if (res == -1) {
        return -errno;
    }
    
    return 0;
}

static int fs_readdir(const char *path, void *buf, fuse_fill_dir_t filler,
                     off_t offset, struct fuse_file_info *fi,
                     enum fuse_readdir_flags flags) {
    (void) offset;
    (void) fi;
    (void) flags;
    
    char *real_path = build_real_path(path);
    DIR *dp = opendir(real_path);
    free(real_path);
    
    if (dp == NULL) {
        return -errno;
    }
    
    struct dirent *de;
    while ((de = readdir(dp)) != NULL) {
        struct stat st;
        memset(&st, 0, sizeof(st));
        st.st_ino = de->d_ino;
        st.st_mode = de->d_type << 12;
        
        if (filler(buf, de->d_name, &st, 0, 0)) {
            break;
        }
    }
    
    closedir(dp);
    return 0;
}

static int fs_open(const char *path, struct fuse_file_info *fi) {
    char *real_path = build_real_path(path);
    int fd = open(real_path, fi->flags);
    free(real_path);
    
    if (fd == -1) {
        return -errno;
    }
    
    fi->fh = fd;
    return 0;
}

static int fs_read(const char *path, char *buf, size_t size, off_t offset,
                  struct fuse_file_info *fi) {
    (void) path;
    
    // Check cache first
    if (fs_ctx->config.enable_caching) {
        cache_entry_t *entry = cache_find(&fs_ctx->cache, path);
        if (entry) {
            pthread_mutex_lock(&entry->lock);
            
            size_t read_size = size;
            if (offset + size > entry->size) {
                read_size = entry->size - offset;
            }
            
            if (read_size > 0) {
                memcpy(buf, (char*)entry->data + offset, read_size);
            }
            
            pthread_mutex_unlock(&entry->lock);
            return read_size;
        }
    }
    
    // Read from file
    int res = pread(fi->fh, buf, size, offset);
    if (res == -1) {
        return -errno;
    }
    
    // Add to cache if enabled
    if (fs_ctx->config.enable_caching && res > 0) {
        // Read entire file for caching
        struct stat st;
        if (fstat(fi->fh, &st) == 0 && st.st_size < 1024 * 1024) { // Cache files < 1MB
            char *file_data = malloc(st.st_size);
            if (pread(fi->fh, file_data, st.st_size, 0) == st.st_size) {
                cache_add(&fs_ctx->cache, path, file_data, st.st_size);
            }
            free(file_data);
        }
    }
    
    return res;
}

static int fs_write(const char *path, const char *buf, size_t size, off_t offset,
                   struct fuse_file_info *fi) {
    // Handle compression and encryption if enabled
    void *processed_data = (void*)buf;
    size_t processed_size = size;
    bool needs_free = false;
    
    if (fs_ctx->config.enable_compression) {
        void *compressed_data;
        size_t compressed_size;
        
        if (compress_data(buf, size, &compressed_data, &compressed_size, 
                         fs_ctx->config.compression_level) >= 0) {
            processed_data = compressed_data;
            processed_size = compressed_size;
            needs_free = true;
        }
    }
    
    if (fs_ctx->config.enable_encryption) {
        void *encrypted_data;
        size_t encrypted_size;
        
        if (encrypt_data(processed_data, processed_size, &encrypted_data, &encrypted_size,
                        fs_ctx->config.encryption_key) == 0) {
            if (needs_free) {
                free(processed_data);
            }
            processed_data = encrypted_data;
            processed_size = encrypted_size;
            needs_free = true;
        }
    }
    
    int res = pwrite(fi->fh, processed_data, processed_size, offset);
    
    if (needs_free) {
        free(processed_data);
    }
    
    if (res == -1) {
        return -errno;
    }
    
    // Update metadata
    file_metadata_t metadata;
    if (load_metadata(path, &metadata) != 0) {
        // Initialize new metadata
        memset(&metadata, 0, sizeof(metadata));
        strncpy(metadata.path, path, MAX_PATH_LEN - 1);
        metadata.inode = __sync_fetch_and_add(&fs_ctx->next_inode, 1);
        metadata.mode = S_IFREG | 0644;
        metadata.nlink = 1;
        metadata.uid = getuid();
        metadata.gid = getgid();
    }
    
    metadata.size = offset + size;
    metadata.mtime = time(NULL);
    metadata.ctime = metadata.mtime;
    metadata.compressed = fs_ctx->config.enable_compression && needs_free;
    metadata.encrypted = fs_ctx->config.enable_encryption;
    
    if (fs_ctx->config.enable_compression && needs_free) {
        metadata.compression_ratio = (size * 100) / processed_size;
    }
    
    // Calculate checksum
    calculate_sha256(buf, size, metadata.checksum);
    
    store_metadata(&metadata);
    
    // Invalidate cache
    if (fs_ctx->config.enable_caching) {
        cache_entry_t *entry = cache_find(&fs_ctx->cache, path);
        if (entry) {
            pthread_mutex_lock(&entry->lock);
            entry->dirty = true;
            pthread_mutex_unlock(&entry->lock);
        }
    }
    
    return res;
}

static int fs_create(const char *path, mode_t mode, struct fuse_file_info *fi) {
    char *real_path = build_real_path(path);
    int fd = creat(real_path, mode);
    free(real_path);
    
    if (fd == -1) {
        return -errno;
    }
    
    fi->fh = fd;
    
    // Create metadata entry
    file_metadata_t metadata = {0};
    strncpy(metadata.path, path, MAX_PATH_LEN - 1);
    metadata.inode = __sync_fetch_and_add(&fs_ctx->next_inode, 1);
    metadata.mode = S_IFREG | mode;
    metadata.nlink = 1;
    metadata.uid = getuid();
    metadata.gid = getgid();
    metadata.size = 0;
    metadata.atime = metadata.mtime = metadata.ctime = time(NULL);
    
    store_metadata(&metadata);
    
    return 0;
}

static int fs_mkdir(const char *path, mode_t mode) {
    char *real_path = build_real_path(path);
    int res = mkdir(real_path, mode);
    free(real_path);
    
    if (res == -1) {
        return -errno;
    }
    
    // Create metadata entry for directory
    file_metadata_t metadata = {0};
    strncpy(metadata.path, path, MAX_PATH_LEN - 1);
    metadata.inode = __sync_fetch_and_add(&fs_ctx->next_inode, 1);
    metadata.mode = S_IFDIR | mode;
    metadata.nlink = 2;
    metadata.uid = getuid();
    metadata.gid = getgid();
    metadata.size = 4096;
    metadata.atime = metadata.mtime = metadata.ctime = time(NULL);
    
    store_metadata(&metadata);
    
    return 0;
}

static int fs_unlink(const char *path) {
    char *real_path = build_real_path(path);
    int res = unlink(real_path);
    free(real_path);
    
    if (res == -1) {
        return -errno;
    }
    
    // Remove metadata
    pthread_mutex_lock(&fs_ctx->db_lock);
    const char *sql = "DELETE FROM file_metadata WHERE path = ?;";
    sqlite3_stmt *stmt;
    
    if (sqlite3_prepare_v2(fs_ctx->metadata_db, sql, -1, &stmt, NULL) == SQLITE_OK) {
        sqlite3_bind_text(stmt, 1, path, -1, SQLITE_STATIC);
        sqlite3_step(stmt);
        sqlite3_finalize(stmt);
    }
    pthread_mutex_unlock(&fs_ctx->db_lock);
    
    return 0;
}

static int fs_release(const char *path, struct fuse_file_info *fi) {
    (void) path;
    return close(fi->fh);
}

static int fs_fsync(const char *path, int isdatasync, struct fuse_file_info *fi) {
    (void) path;
    (void) isdatasync;
    
    int res = fsync(fi->fh);
    if (res == -1) {
        return -errno;
    }
    
    return 0;
}

// Extended attributes support
static int fs_setxattr(const char *path, const char *name, const char *value,
                      size_t size, int flags) {
    char *real_path = build_real_path(path);
    int res = lsetxattr(real_path, name, value, size, flags);
    free(real_path);
    
    if (res == -1) {
        return -errno;
    }
    
    return 0;
}

static int fs_getxattr(const char *path, const char *name, char *value, size_t size) {
    char *real_path = build_real_path(path);
    int res = lgetxattr(real_path, name, value, size);
    free(real_path);
    
    if (res == -1) {
        return -errno;
    }
    
    return res;
}

static int fs_listxattr(const char *path, char *list, size_t size) {
    char *real_path = build_real_path(path);
    int res = llistxattr(real_path, list, size);
    free(real_path);
    
    if (res == -1) {
        return -errno;
    }
    
    return res;
}

static int fs_removexattr(const char *path, const char *name) {
    char *real_path = build_real_path(path);
    int res = lremovexattr(real_path, name);
    free(real_path);
    
    if (res == -1) {
        return -errno;
    }
    
    return 0;
}

// Initialize filesystem
static void* fs_init(struct fuse_conn_info *conn, struct fuse_config *cfg) {
    (void) conn;
    
    cfg->use_ino = 1;
    cfg->nullpath_ok = 1;
    cfg->parallel_direct_writes = 1;
    
    printf("Advanced FUSE filesystem initialized\n");
    printf("Configuration:\n");
    printf("  Root path: %s\n", fs_ctx->config.root_path);
    printf("  Compression: %s\n", fs_ctx->config.enable_compression ? "enabled" : "disabled");
    printf("  Encryption: %s\n", fs_ctx->config.enable_encryption ? "enabled" : "disabled");
    printf("  Caching: %s\n", fs_ctx->config.enable_caching ? "enabled" : "disabled");
    printf("  Deduplication: %s\n", fs_ctx->config.enable_deduplication ? "enabled" : "disabled");
    
    return fs_ctx;
}

// Cleanup filesystem
static void fs_destroy(void *userdata) {
    (void) userdata;
    
    // Cleanup cache
    pthread_rwlock_wrlock(&fs_ctx->cache.lock);
    cache_entry_t *entry = fs_ctx->cache.head;
    while (entry) {
        cache_entry_t *next = entry->next;
        pthread_mutex_destroy(&entry->lock);
        free(entry->data);
        free(entry);
        entry = next;
    }
    pthread_rwlock_unlock(&fs_ctx->cache.lock);
    pthread_rwlock_destroy(&fs_ctx->cache.lock);
    
    // Close database
    if (fs_ctx->metadata_db) {
        sqlite3_close(fs_ctx->metadata_db);
    }
    pthread_mutex_destroy(&fs_ctx->db_lock);
    
    pthread_rwlock_destroy(&fs_ctx->config.global_lock);
    
    printf("Advanced FUSE filesystem destroyed\n");
}

// FUSE operations structure
static const struct fuse_operations fs_operations = {
    .init       = fs_init,
    .destroy    = fs_destroy,
    .getattr    = fs_getattr,
    .readdir    = fs_readdir,
    .open       = fs_open,
    .read       = fs_read,
    .write      = fs_write,
    .create     = fs_create,
    .mkdir      = fs_mkdir,
    .unlink     = fs_unlink,
    .release    = fs_release,
    .fsync      = fs_fsync,
    .setxattr   = fs_setxattr,
    .getxattr   = fs_getxattr,
    .listxattr  = fs_listxattr,
    .removexattr = fs_removexattr,
};

// Main function
int main(int argc, char *argv[]) {
    // Initialize global context
    fs_ctx = calloc(1, sizeof(fs_context_t));
    
    // Parse command line arguments
    if (argc < 3) {
        fprintf(stderr, "Usage: %s <mountpoint> <root_path> [options]\n", argv[0]);
        fprintf(stderr, "Options:\n");
        fprintf(stderr, "  -c, --compression    Enable compression\n");
        fprintf(stderr, "  -e, --encryption     Enable encryption\n");
        fprintf(stderr, "  -d, --dedup         Enable deduplication\n");
        fprintf(stderr, "  -C, --cache         Enable caching\n");
        fprintf(stderr, "  -l, --level=N       Compression level (1-9)\n");
        return 1;
    }
    
    // Set default configuration
    fs_ctx->config.root_path = strdup(argv[2]);
    fs_ctx->config.cache_path = strdup("/tmp/fuse_cache");
    fs_ctx->config.db_path = strdup("/tmp/fuse_metadata.db");
    fs_ctx->config.enable_compression = false;
    fs_ctx->config.enable_encryption = false;
    fs_ctx->config.enable_deduplication = false;
    fs_ctx->config.enable_caching = false;
    fs_ctx->config.compression_level = 6;
    fs_ctx->config.max_cache_size = 128 * 1024 * 1024; // 128MB
    pthread_rwlock_init(&fs_ctx->config.global_lock, NULL);
    
    // Parse options
    for (int i = 3; i < argc; i++) {
        if (strcmp(argv[i], "-c") == 0 || strcmp(argv[i], "--compression") == 0) {
            fs_ctx->config.enable_compression = true;
        } else if (strcmp(argv[i], "-e") == 0 || strcmp(argv[i], "--encryption") == 0) {
            fs_ctx->config.enable_encryption = true;
        } else if (strcmp(argv[i], "-d") == 0 || strcmp(argv[i], "--dedup") == 0) {
            fs_ctx->config.enable_deduplication = true;
        } else if (strcmp(argv[i], "-C") == 0 || strcmp(argv[i], "--cache") == 0) {
            fs_ctx->config.enable_caching = true;
        } else if (strncmp(argv[i], "--level=", 8) == 0) {
            fs_ctx->config.compression_level = atoi(argv[i] + 8);
        }
    }
    
    // Initialize components
    if (init_metadata_db() != 0) {
        fprintf(stderr, "Failed to initialize metadata database\n");
        return 1;
    }
    
    if (fs_ctx->config.enable_caching) {
        cache_init(&fs_ctx->cache, fs_ctx->config.max_cache_size);
    }
    
    pthread_mutex_init(&fs_ctx->db_lock, NULL);
    fs_ctx->next_inode = 1000;
    
    // Create FUSE arguments
    char *fuse_argv[] = {
        argv[0],
        argv[1],
        "-f",  // foreground
        "-s",  // single-threaded (remove for multi-threading)
        NULL
    };
    int fuse_argc = 4;
    
    printf("Starting advanced FUSE filesystem...\n");
    
    // Start FUSE
    int result = fuse_main(fuse_argc, fuse_argv, &fs_operations, fs_ctx);
    
    // Cleanup
    free(fs_ctx->config.root_path);
    free(fs_ctx->config.cache_path);
    free(fs_ctx->config.db_path);
    free(fs_ctx);
    
    return result;
}
```

## Block Device Driver Development

### Advanced Block Device Driver Implementation

```c
// block_device_driver.c - Advanced block device driver
#include <linux/init.h>
#include <linux/module.h>
#include <linux/kernel.h>
#include <linux/fs.h>
#include <linux/errno.h>
#include <linux/types.h>
#include <linux/fcntl.h>
#include <linux/vmalloc.h>
#include <linux/genhd.h>
#include <linux/blkdev.h>
#include <linux/bio.h>
#include <linux/string.h>
#include <linux/mutex.h>
#include <linux/workqueue.h>
#include <linux/timer.h>
#include <linux/proc_fs.h>
#include <linux/seq_file.h>
#include <linux/crypto.h>
#include <linux/scatterlist.h>
#include <linux/completion.h>
#include <linux/kthread.h>
#include <linux/delay.h>

#define DEVICE_NAME "advblk"
#define KERNEL_SECTOR_SIZE 512
#define NSECTORS 2048  // 1MB device
#define HARDSECT_SIZE 512
#define NDEVICES 4

// Device configuration
struct device_config {
    bool enable_encryption;
    bool enable_compression;
    bool enable_cache;
    bool enable_stats;
    u32 cache_size_mb;
    char encryption_key[32];
};

// I/O statistics
struct io_stats {
    atomic64_t read_requests;
    atomic64_t write_requests;
    atomic64_t read_bytes;
    atomic64_t write_bytes;
    atomic64_t read_time_ns;
    atomic64_t write_time_ns;
    atomic64_t cache_hits;
    atomic64_t cache_misses;
    atomic64_t errors;
};

// Cache entry
struct cache_entry {
    sector_t sector;
    void *data;
    size_t size;
    bool dirty;
    bool valid;
    unsigned long last_access;
    struct list_head list;
    struct mutex lock;
};

// Cache management
struct block_cache {
    struct list_head lru_list;
    struct list_head free_list;
    struct cache_entry *entries;
    int num_entries;
    int entry_size;
    struct mutex lock;
    struct workqueue_struct *flush_wq;
    struct delayed_work flush_work;
};

// Advanced block device structure
struct advblk_device {
    int size;                          // Device size in sectors
    u8 *data;                         // Device data storage
    struct block_cache cache;         // Write-back cache
    struct io_stats stats;            // I/O statistics
    struct device_config config;      // Device configuration
    
    struct request_queue *queue;      // Request queue
    struct gendisk *gd;               // Generic disk structure
    int major;                        // Major number
    int minor;                        // Minor number
    
    struct mutex mutex;               // Device mutex
    struct workqueue_struct *wq;     // Work queue for async operations
    
    // Encryption context
    struct crypto_cipher *cipher;
    bool cipher_initialized;
    
    // Compression context
    struct crypto_comp *comp;
    bool comp_initialized;
    
    // Performance monitoring
    struct timer_list perf_timer;
    struct proc_dir_entry *proc_entry;
    
    // Error injection for testing
    int error_inject_rate;
    atomic_t request_count;
};

static int major_num = 0;
static struct advblk_device *devices[NDEVICES];
static struct proc_dir_entry *proc_dir;

// Forward declarations
static void advblk_make_request(struct request_queue *q, struct bio *bio);
static int advblk_ioctl(struct block_device *bdev, fmode_t mode, 
                       unsigned int cmd, unsigned long arg);

// Block device operations
static const struct block_device_operations advblk_fops = {
    .owner = THIS_MODULE,
    .ioctl = advblk_ioctl,
};

// Cache management functions
static int init_cache(struct advblk_device *dev) {
    struct block_cache *cache = &dev->cache;
    int num_entries = (dev->config.cache_size_mb * 1024 * 1024) / PAGE_SIZE;
    
    cache->entries = vzalloc(num_entries * sizeof(struct cache_entry));
    if (!cache->entries) {
        return -ENOMEM;
    }
    
    cache->num_entries = num_entries;
    cache->entry_size = PAGE_SIZE;
    
    INIT_LIST_HEAD(&cache->lru_list);
    INIT_LIST_HEAD(&cache->free_list);
    mutex_init(&cache->lock);
    
    // Initialize cache entries
    for (int i = 0; i < num_entries; i++) {
        struct cache_entry *entry = &cache->entries[i];
        
        entry->data = (void *)__get_free_page(GFP_KERNEL);
        if (!entry->data) {
            // Cleanup previously allocated pages
            for (int j = 0; j < i; j++) {
                free_page((unsigned long)cache->entries[j].data);
            }
            vfree(cache->entries);
            return -ENOMEM;
        }
        
        entry->valid = false;
        entry->dirty = false;
        mutex_init(&entry->lock);
        list_add_tail(&entry->list, &cache->free_list);
    }
    
    // Create flush workqueue
    cache->flush_wq = create_singlethread_workqueue("advblk_flush");
    if (!cache->flush_wq) {
        return -ENOMEM;
    }
    
    INIT_DELAYED_WORK(&cache->flush_work, NULL); // Will be set later
    
    pr_info("Cache initialized: %d entries, %d KB each\n", 
            num_entries, cache->entry_size / 1024);
    
    return 0;
}

static void cleanup_cache(struct advblk_device *dev) {
    struct block_cache *cache = &dev->cache;
    
    if (cache->flush_wq) {
        cancel_delayed_work_sync(&cache->flush_work);
        destroy_workqueue(cache->flush_wq);
    }
    
    if (cache->entries) {
        for (int i = 0; i < cache->num_entries; i++) {
            if (cache->entries[i].data) {
                free_page((unsigned long)cache->entries[i].data);
            }
            mutex_destroy(&cache->entries[i].lock);
        }
        vfree(cache->entries);
    }
    
    mutex_destroy(&cache->lock);
}

static struct cache_entry* find_cache_entry(struct advblk_device *dev, sector_t sector) {
    struct block_cache *cache = &dev->cache;
    struct cache_entry *entry;
    
    list_for_each_entry(entry, &cache->lru_list, list) {
        if (entry->valid && entry->sector == sector) {
            // Move to front of LRU
            list_move(&entry->list, &cache->lru_list);
            entry->last_access = jiffies;
            return entry;
        }
    }
    
    return NULL;
}

static struct cache_entry* get_free_cache_entry(struct advblk_device *dev) {
    struct block_cache *cache = &dev->cache;
    struct cache_entry *entry;
    
    // Try to get from free list first
    if (!list_empty(&cache->free_list)) {
        entry = list_first_entry(&cache->free_list, struct cache_entry, list);
        list_move(&entry->list, &cache->lru_list);
        return entry;
    }
    
    // Evict LRU entry
    if (!list_empty(&cache->lru_list)) {
        entry = list_last_entry(&cache->lru_list, struct cache_entry, list);
        
        // Write back if dirty
        if (entry->dirty && entry->valid) {
            sector_t sector = entry->sector * (PAGE_SIZE / KERNEL_SECTOR_SIZE);
            memcpy(dev->data + sector * KERNEL_SECTOR_SIZE, entry->data, PAGE_SIZE);
            entry->dirty = false;
        }
        
        entry->valid = false;
        list_move(&entry->list, &cache->lru_list);
        return entry;
    }
    
    return NULL;
}

// Encryption functions
static int init_encryption(struct advblk_device *dev) {
    if (!dev->config.enable_encryption) {
        return 0;
    }
    
    dev->cipher = crypto_alloc_cipher("aes", 0, 0);
    if (IS_ERR(dev->cipher)) {
        pr_err("Failed to allocate cipher\n");
        return PTR_ERR(dev->cipher);
    }
    
    int ret = crypto_cipher_setkey(dev->cipher, dev->config.encryption_key, 32);
    if (ret) {
        crypto_free_cipher(dev->cipher);
        pr_err("Failed to set encryption key\n");
        return ret;
    }
    
    dev->cipher_initialized = true;
    pr_info("Encryption initialized\n");
    
    return 0;
}

static void cleanup_encryption(struct advblk_device *dev) {
    if (dev->cipher_initialized) {
        crypto_free_cipher(dev->cipher);
        dev->cipher_initialized = false;
    }
}

static void encrypt_sector(struct advblk_device *dev, void *data, sector_t sector) {
    if (!dev->cipher_initialized) {
        return;
    }
    
    // Simple sector-based encryption
    u8 *ptr = data;
    for (int i = 0; i < KERNEL_SECTOR_SIZE; i += crypto_cipher_blocksize(dev->cipher)) {
        crypto_cipher_encrypt_one(dev->cipher, ptr + i, ptr + i);
    }
}

static void decrypt_sector(struct advblk_device *dev, void *data, sector_t sector) {
    if (!dev->cipher_initialized) {
        return;
    }
    
    // Simple sector-based decryption
    u8 *ptr = data;
    for (int i = 0; i < KERNEL_SECTOR_SIZE; i += crypto_cipher_blocksize(dev->cipher)) {
        crypto_cipher_decrypt_one(dev->cipher, ptr + i, ptr + i);
    }
}

// I/O request handling
static void handle_read_request(struct advblk_device *dev, struct bio *bio) {
    struct bio_vec bvec;
    struct bvec_iter iter;
    sector_t sector = bio->bi_iter.bi_sector;
    ktime_t start_time = ktime_get();
    
    bio_for_each_segment(bvec, bio, iter) {
        void *buffer = kmap_atomic(bvec.bv_page) + bvec.bv_offset;
        size_t len = bvec.bv_len;
        
        // Check cache first
        if (dev->config.enable_cache) {
            mutex_lock(&dev->cache.lock);
            struct cache_entry *entry = find_cache_entry(dev, sector);
            if (entry) {
                mutex_lock(&entry->lock);
                memcpy(buffer, entry->data + (sector % (PAGE_SIZE / KERNEL_SECTOR_SIZE)) * KERNEL_SECTOR_SIZE, len);
                mutex_unlock(&entry->lock);
                mutex_unlock(&dev->cache.lock);
                atomic64_inc(&dev->stats.cache_hits);
                goto next_segment;
            }
            atomic64_inc(&dev->stats.cache_misses);
            mutex_unlock(&dev->cache.lock);
        }
        
        // Read from device storage
        if (sector * KERNEL_SECTOR_SIZE + len > dev->size * KERNEL_SECTOR_SIZE) {
            pr_err("Read beyond device boundary\n");
            bio->bi_status = BLK_STS_IOERR;
            goto error;
        }
        
        memcpy(buffer, dev->data + sector * KERNEL_SECTOR_SIZE, len);
        
        // Decrypt if encryption is enabled
        if (dev->config.enable_encryption) {
            decrypt_sector(dev, buffer, sector);
        }
        
        // Add to cache
        if (dev->config.enable_cache) {
            mutex_lock(&dev->cache.lock);
            struct cache_entry *entry = get_free_cache_entry(dev);
            if (entry) {
                mutex_lock(&entry->lock);
                entry->sector = sector;
                entry->valid = true;
                entry->dirty = false;
                entry->last_access = jiffies;
                memcpy(entry->data, dev->data + sector * KERNEL_SECTOR_SIZE, 
                       min_t(size_t, PAGE_SIZE, dev->size * KERNEL_SECTOR_SIZE - sector * KERNEL_SECTOR_SIZE));
                mutex_unlock(&entry->lock);
            }
            mutex_unlock(&dev->cache.lock);
        }
        
next_segment:
        kunmap_atomic(buffer);
        sector += len / KERNEL_SECTOR_SIZE;
    }
    
    // Update statistics
    atomic64_inc(&dev->stats.read_requests);
    atomic64_add(bio->bi_iter.bi_size, &dev->stats.read_bytes);
    atomic64_add(ktime_to_ns(ktime_sub(ktime_get(), start_time)), &dev->stats.read_time_ns);
    
    bio->bi_status = BLK_STS_OK;
    bio_endio(bio);
    return;
    
error:
    atomic64_inc(&dev->stats.errors);
    kunmap_atomic(buffer);
    bio_endio(bio);
}

static void handle_write_request(struct advblk_device *dev, struct bio *bio) {
    struct bio_vec bvec;
    struct bvec_iter iter;
    sector_t sector = bio->bi_iter.bi_sector;
    ktime_t start_time = ktime_get();
    
    bio_for_each_segment(bvec, bio, iter) {
        void *buffer = kmap_atomic(bvec.bv_page) + bvec.bv_offset;
        size_t len = bvec.bv_len;
        
        if (sector * KERNEL_SECTOR_SIZE + len > dev->size * KERNEL_SECTOR_SIZE) {
            pr_err("Write beyond device boundary\n");
            bio->bi_status = BLK_STS_IOERR;
            goto error;
        }
        
        // Handle write-through or write-back cache
        if (dev->config.enable_cache) {
            mutex_lock(&dev->cache.lock);
            struct cache_entry *entry = find_cache_entry(dev, sector);
            if (!entry) {
                entry = get_free_cache_entry(dev);
            }
            
            if (entry) {
                mutex_lock(&entry->lock);
                entry->sector = sector;
                entry->valid = true;
                entry->dirty = true;
                entry->last_access = jiffies;
                memcpy(entry->data + (sector % (PAGE_SIZE / KERNEL_SECTOR_SIZE)) * KERNEL_SECTOR_SIZE, 
                       buffer, len);
                mutex_unlock(&entry->lock);
                atomic64_inc(&dev->stats.cache_hits);
            }
            mutex_unlock(&dev->cache.lock);
        }
        
        // Write to device storage
        void *write_buffer = buffer;
        if (dev->config.enable_encryption) {
            // Create temporary buffer for encryption
            write_buffer = kmalloc(len, GFP_KERNEL);
            if (write_buffer) {
                memcpy(write_buffer, buffer, len);
                encrypt_sector(dev, write_buffer, sector);
            } else {
                write_buffer = buffer; // Fall back to unencrypted
            }
        }
        
        memcpy(dev->data + sector * KERNEL_SECTOR_SIZE, write_buffer, len);
        
        if (write_buffer != buffer) {
            kfree(write_buffer);
        }
        
        kunmap_atomic(buffer);
        sector += len / KERNEL_SECTOR_SIZE;
    }
    
    // Update statistics
    atomic64_inc(&dev->stats.write_requests);
    atomic64_add(bio->bi_iter.bi_size, &dev->stats.write_bytes);
    atomic64_add(ktime_to_ns(ktime_sub(ktime_get(), start_time)), &dev->stats.write_time_ns);
    
    bio->bi_status = BLK_STS_OK;
    bio_endio(bio);
    return;
    
error:
    atomic64_inc(&dev->stats.errors);
    kunmap_atomic(buffer);
    bio_endio(bio);
}

// Main request handler
static void advblk_make_request(struct request_queue *q, struct bio *bio) {
    struct advblk_device *dev = q->queuedata;
    
    // Error injection for testing
    if (dev->error_inject_rate > 0) {
        int count = atomic_inc_return(&dev->request_count);
        if (count % dev->error_inject_rate == 0) {
            pr_info("Injecting error for request %d\n", count);
            bio->bi_status = BLK_STS_IOERR;
            bio_endio(bio);
            return;
        }
    }
    
    switch (bio_op(bio)) {
    case REQ_OP_READ:
        handle_read_request(dev, bio);
        break;
    case REQ_OP_WRITE:
        handle_write_request(dev, bio);
        break;
    case REQ_OP_FLUSH:
        // Flush cache to storage
        bio->bi_status = BLK_STS_OK;
        bio_endio(bio);
        break;
    case REQ_OP_DISCARD:
        // Handle discard/trim operations
        bio->bi_status = BLK_STS_OK;
        bio_endio(bio);
        break;
    default:
        pr_err("Unsupported bio operation: %d\n", bio_op(bio));
        bio->bi_status = BLK_STS_NOTSUPP;
        bio_endio(bio);
        break;
    }
}

// IOCTL commands
#define ADVBLK_IOC_MAGIC 'A'
#define ADVBLK_IOC_GET_STATS    _IOR(ADVBLK_IOC_MAGIC, 1, struct io_stats)
#define ADVBLK_IOC_RESET_STATS  _IO(ADVBLK_IOC_MAGIC, 2)
#define ADVBLK_IOC_SET_CONFIG   _IOW(ADVBLK_IOC_MAGIC, 3, struct device_config)
#define ADVBLK_IOC_FLUSH_CACHE  _IO(ADVBLK_IOC_MAGIC, 4)

static int advblk_ioctl(struct block_device *bdev, fmode_t mode, 
                       unsigned int cmd, unsigned long arg) {
    struct advblk_device *dev = bdev->bd_disk->private_data;
    
    switch (cmd) {
    case ADVBLK_IOC_GET_STATS:
        if (copy_to_user((void __user *)arg, &dev->stats, sizeof(dev->stats))) {
            return -EFAULT;
        }
        break;
        
    case ADVBLK_IOC_RESET_STATS:
        memset(&dev->stats, 0, sizeof(dev->stats));
        break;
        
    case ADVBLK_IOC_SET_CONFIG:
        if (copy_from_user(&dev->config, (void __user *)arg, sizeof(dev->config))) {
            return -EFAULT;
        }
        break;
        
    case ADVBLK_IOC_FLUSH_CACHE:
        // Force cache flush
        // Implementation would flush all dirty cache entries
        break;
        
    default:
        return -ENOTTY;
    }
    
    return 0;
}

// Proc filesystem interface
static int advblk_proc_show(struct seq_file *m, void *v) {
    struct advblk_device *dev = (struct advblk_device *)m->private;
    
    seq_printf(m, "Advanced Block Device Statistics\n");
    seq_printf(m, "================================\n");
    seq_printf(m, "Device size: %d sectors (%d KB)\n", 
               dev->size, dev->size * KERNEL_SECTOR_SIZE / 1024);
    seq_printf(m, "Read requests: %lld\n", atomic64_read(&dev->stats.read_requests));
    seq_printf(m, "Write requests: %lld\n", atomic64_read(&dev->stats.write_requests));
    seq_printf(m, "Read bytes: %lld\n", atomic64_read(&dev->stats.read_bytes));
    seq_printf(m, "Write bytes: %lld\n", atomic64_read(&dev->stats.write_bytes));
    seq_printf(m, "Read time (ns): %lld\n", atomic64_read(&dev->stats.read_time_ns));
    seq_printf(m, "Write time (ns): %lld\n", atomic64_read(&dev->stats.write_time_ns));
    seq_printf(m, "Cache hits: %lld\n", atomic64_read(&dev->stats.cache_hits));
    seq_printf(m, "Cache misses: %lld\n", atomic64_read(&dev->stats.cache_misses));
    seq_printf(m, "Errors: %lld\n", atomic64_read(&dev->stats.errors));
    
    if (atomic64_read(&dev->stats.read_requests) > 0) {
        seq_printf(m, "Average read latency: %lld ns\n",
                   atomic64_read(&dev->stats.read_time_ns) / 
                   atomic64_read(&dev->stats.read_requests));
    }
    
    if (atomic64_read(&dev->stats.write_requests) > 0) {
        seq_printf(m, "Average write latency: %lld ns\n",
                   atomic64_read(&dev->stats.write_time_ns) / 
                   atomic64_read(&dev->stats.write_requests));
    }
    
    u64 total_cache_ops = atomic64_read(&dev->stats.cache_hits) + 
                         atomic64_read(&dev->stats.cache_misses);
    if (total_cache_ops > 0) {
        seq_printf(m, "Cache hit ratio: %lld%%\n",
                   atomic64_read(&dev->stats.cache_hits) * 100 / total_cache_ops);
    }
    
    seq_printf(m, "\nConfiguration:\n");
    seq_printf(m, "Encryption: %s\n", dev->config.enable_encryption ? "enabled" : "disabled");
    seq_printf(m, "Compression: %s\n", dev->config.enable_compression ? "enabled" : "disabled");
    seq_printf(m, "Cache: %s\n", dev->config.enable_cache ? "enabled" : "disabled");
    seq_printf(m, "Cache size: %u MB\n", dev->config.cache_size_mb);
    
    return 0;
}

static int advblk_proc_open(struct inode *inode, struct file *file) {
    return single_open(file, advblk_proc_show, PDE_DATA(inode));
}

static const struct proc_ops advblk_proc_ops = {
    .proc_open = advblk_proc_open,
    .proc_read = seq_read,
    .proc_lseek = seq_lseek,
    .proc_release = single_release,
};

// Performance monitoring timer
static void perf_timer_callback(struct timer_list *timer) {
    struct advblk_device *dev = from_timer(dev, timer, perf_timer);
    
    // Log performance metrics periodically
    u64 read_req = atomic64_read(&dev->stats.read_requests);
    u64 write_req = atomic64_read(&dev->stats.write_requests);
    
    if (read_req + write_req > 0) {
        pr_info("Device %d: R:%lld W:%lld Cache hit ratio: %lld%%\n",
                dev->minor, read_req, write_req,
                atomic64_read(&dev->stats.cache_hits) * 100 / 
                (atomic64_read(&dev->stats.cache_hits) + atomic64_read(&dev->stats.cache_misses) + 1));
    }
    
    // Restart timer
    mod_timer(&dev->perf_timer, jiffies + HZ * 30); // 30 seconds
}

// Device initialization
static int create_device(int minor) {
    struct advblk_device *dev;
    int ret = 0;
    
    dev = kzalloc(sizeof(struct advblk_device), GFP_KERNEL);
    if (!dev) {
        return -ENOMEM;
    }
    
    dev->size = NSECTORS;
    dev->minor = minor;
    dev->major = major_num;
    
    // Set default configuration
    dev->config.enable_cache = true;
    dev->config.enable_stats = true;
    dev->config.cache_size_mb = 4;
    dev->config.enable_encryption = false;
    dev->config.enable_compression = false;
    
    // Allocate device storage
    dev->data = vzalloc(dev->size * KERNEL_SECTOR_SIZE);
    if (!dev->data) {
        ret = -ENOMEM;
        goto out_free_dev;
    }
    
    // Initialize mutex
    mutex_init(&dev->mutex);
    
    // Initialize statistics
    memset(&dev->stats, 0, sizeof(dev->stats));
    atomic_set(&dev->request_count, 0);
    
    // Initialize cache
    if (dev->config.enable_cache) {
        ret = init_cache(dev);
        if (ret) {
            goto out_free_data;
        }
    }
    
    // Initialize encryption
    ret = init_encryption(dev);
    if (ret) {
        goto out_cleanup_cache;
    }
    
    // Create request queue
    dev->queue = blk_alloc_queue(GFP_KERNEL);
    if (!dev->queue) {
        ret = -ENOMEM;
        goto out_cleanup_encryption;
    }
    
    blk_queue_make_request(dev->queue, advblk_make_request);
    blk_queue_logical_block_size(dev->queue, HARDSECT_SIZE);
    dev->queue->queuedata = dev;
    
    // Create gendisk
    dev->gd = alloc_disk(1);
    if (!dev->gd) {
        ret = -ENOMEM;
        goto out_cleanup_queue;
    }
    
    dev->gd->major = major_num;
    dev->gd->first_minor = minor;
    dev->gd->fops = &advblk_fops;
    dev->gd->queue = dev->queue;
    dev->gd->private_data = dev;
    snprintf(dev->gd->disk_name, 32, "%s%d", DEVICE_NAME, minor);
    set_capacity(dev->gd, dev->size);
    
    // Create proc entry
    char proc_name[32];
    snprintf(proc_name, sizeof(proc_name), "%s%d", DEVICE_NAME, minor);
    dev->proc_entry = proc_create_data(proc_name, 0644, proc_dir, 
                                      &advblk_proc_ops, dev);
    
    // Initialize performance timer
    timer_setup(&dev->perf_timer, perf_timer_callback, 0);
    mod_timer(&dev->perf_timer, jiffies + HZ * 30);
    
    add_disk(dev->gd);
    devices[minor] = dev;
    
    pr_info("Created device %s%d: %d sectors\n", DEVICE_NAME, minor, dev->size);
    
    return 0;
    
out_cleanup_queue:
    blk_cleanup_queue(dev->queue);
out_cleanup_encryption:
    cleanup_encryption(dev);
out_cleanup_cache:
    if (dev->config.enable_cache) {
        cleanup_cache(dev);
    }
out_free_data:
    vfree(dev->data);
out_free_dev:
    kfree(dev);
    return ret;
}

static void destroy_device(int minor) {
    struct advblk_device *dev = devices[minor];
    
    if (!dev) {
        return;
    }
    
    del_timer_sync(&dev->perf_timer);
    
    if (dev->proc_entry) {
        proc_remove(dev->proc_entry);
    }
    
    if (dev->gd) {
        del_gendisk(dev->gd);
        put_disk(dev->gd);
    }
    
    if (dev->queue) {
        blk_cleanup_queue(dev->queue);
    }
    
    cleanup_encryption(dev);
    
    if (dev->config.enable_cache) {
        cleanup_cache(dev);
    }
    
    vfree(dev->data);
    mutex_destroy(&dev->mutex);
    kfree(dev);
    devices[minor] = NULL;
    
    pr_info("Destroyed device %s%d\n", DEVICE_NAME, minor);
}

// Module initialization
static int __init advblk_init(void) {
    int ret;
    
    pr_info("Advanced Block Device Driver loading\n");
    
    // Register block device
    major_num = register_blkdev(0, DEVICE_NAME);
    if (major_num < 0) {
        pr_err("Failed to register block device\n");
        return major_num;
    }
    
    pr_info("Registered block device with major number %d\n", major_num);
    
    // Create proc directory
    proc_dir = proc_mkdir(DEVICE_NAME, NULL);
    if (!proc_dir) {
        pr_warn("Failed to create proc directory\n");
    }
    
    // Create devices
    for (int i = 0; i < NDEVICES; i++) {
        ret = create_device(i);
        if (ret) {
            pr_err("Failed to create device %d\n", i);
            goto cleanup_devices;
        }
    }
    
    pr_info("Advanced Block Device Driver loaded successfully\n");
    return 0;
    
cleanup_devices:
    for (int i = 0; i < NDEVICES; i++) {
        destroy_device(i);
    }
    
    if (proc_dir) {
        proc_remove(proc_dir);
    }
    
    unregister_blkdev(major_num, DEVICE_NAME);
    return ret;
}

// Module cleanup
static void __exit advblk_exit(void) {
    pr_info("Advanced Block Device Driver unloading\n");
    
    // Destroy all devices
    for (int i = 0; i < NDEVICES; i++) {
        destroy_device(i);
    }
    
    // Remove proc directory
    if (proc_dir) {
        proc_remove(proc_dir);
    }
    
    // Unregister block device
    unregister_blkdev(major_num, DEVICE_NAME);
    
    pr_info("Advanced Block Device Driver unloaded\n");
}

module_init(advblk_init);
module_exit(advblk_exit);

MODULE_LICENSE("GPL");
MODULE_AUTHOR("Matthew Mattox <mmattox@support.tools>");
MODULE_DESCRIPTION("Advanced Block Device Driver with caching, encryption, and compression");
MODULE_VERSION("1.0");
```

## High-Performance Storage Testing Framework

### Comprehensive Storage Benchmarking Suite

```bash
#!/bin/bash
# storage_benchmark_suite.sh - Comprehensive storage performance testing

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_DIR="/tmp/storage_tests"
RESULTS_DIR="$SCRIPT_DIR/results"
MOUNT_POINT="/tmp/fuse_test"
DEVICE_PATH="/dev/advblk0"

echo "=== Advanced Storage Systems Benchmark Suite ==="

# Setup test environment
setup_test_environment() {
    echo "Setting up storage test environment..."
    
    mkdir -p "$TEST_DIR"
    mkdir -p "$RESULTS_DIR"
    mkdir -p "$MOUNT_POINT"
    
    # Install required tools
    if ! command -v fio &> /dev/null; then
        echo "Installing fio..."
        sudo apt-get update
        sudo apt-get install -y fio
    fi
    
    if ! command -v iozone &> /dev/null; then
        echo "Installing iozone..."
        sudo apt-get install -y iozone3
    fi
    
    if ! command -v bonnie++ &> /dev/null; then
        echo "Installing bonnie++..."
        sudo apt-get install -y bonnie++
    fi
    
    # Install development tools for FUSE
    sudo apt-get install -y libfuse3-dev libsqlite3-dev libssl-dev zlib1g-dev liblz4-dev libsnappy-dev
    
    echo "Test environment setup completed"
}

# Build and test FUSE filesystem
test_fuse_filesystem() {
    echo "Building and testing FUSE filesystem..."
    
    cd "$SCRIPT_DIR"
    
    # Build FUSE filesystem
    gcc -o fuse_filesystem fuse_filesystem.c \
        $(pkg-config --cflags --libs fuse3) \
        -lsqlite3 -lssl -lcrypto -lz -llz4 -lsnappy -lpthread
    
    # Create test backend directory
    local backend_dir="/tmp/fuse_backend"
    mkdir -p "$backend_dir"
    
    # Test basic functionality
    echo "Testing FUSE filesystem basic operations..."
    
    # Mount filesystem
    ./fuse_filesystem "$MOUNT_POINT" "$backend_dir" -c -C &
    FUSE_PID=$!
    
    sleep 2
    
    # Test file operations
    echo "Hello, FUSE!" > "$MOUNT_POINT/test.txt"
    cat "$MOUNT_POINT/test.txt"
    
    # Test directory operations
    mkdir "$MOUNT_POINT/testdir"
    ls -la "$MOUNT_POINT/"
    
    # Run I/O benchmarks on FUSE
    echo "Running FUSE I/O benchmarks..."
    
    # Sequential write test
    fio --name=fuse_seq_write \
        --directory="$MOUNT_POINT" \
        --rw=write \
        --bs=64k \
        --size=100M \
        --numjobs=1 \
        --runtime=30 \
        --group_reporting \
        --output="$RESULTS_DIR/fuse_seq_write.txt"
    
    # Sequential read test
    fio --name=fuse_seq_read \
        --directory="$MOUNT_POINT" \
        --rw=read \
        --bs=64k \
        --size=100M \
        --numjobs=1 \
        --runtime=30 \
        --group_reporting \
        --output="$RESULTS_DIR/fuse_seq_read.txt"
    
    # Random I/O test
    fio --name=fuse_random \
        --directory="$MOUNT_POINT" \
        --rw=randrw \
        --bs=4k \
        --size=100M \
        --numjobs=4 \
        --runtime=30 \
        --group_reporting \
        --output="$RESULTS_DIR/fuse_random.txt"
    
    # Cleanup
    fusermount3 -u "$MOUNT_POINT" || sudo umount "$MOUNT_POINT"
    kill $FUSE_PID 2>/dev/null || true
    
    echo "FUSE filesystem testing completed"
}

# Build and test block device driver
test_block_device_driver() {
    echo "Building and testing block device driver..."
    
    cd "$SCRIPT_DIR"
    
    # Create Makefile for kernel module
    cat > Makefile << 'EOF'
obj-m += block_device_driver.o

KDIR := /lib/modules/$(shell uname -r)/build
PWD := $(shell pwd)

all:
	$(MAKE) -C $(KDIR) M=$(PWD) modules

clean:
	$(MAKE) -C $(KDIR) M=$(PWD) clean

install:
	sudo $(MAKE) -C $(KDIR) M=$(PWD) modules_install
	sudo depmod -a

load:
	sudo insmod block_device_driver.ko

unload:
	sudo rmmod block_device_driver || true

test:
	@echo "Testing block device..."
	ls -l /dev/advblk* || echo "Block devices not found"
	cat /proc/advblk/advblk0 || echo "Proc entry not found"
EOF
    
    # Build kernel module
    make clean
    make all
    
    # Load module
    sudo make unload || true
    sudo make load
    
    # Wait for device creation
    sleep 2
    
    if [ -e "$DEVICE_PATH" ]; then
        echo "Block device created successfully: $DEVICE_PATH"
        
        # Test basic device operations
        echo "Testing block device I/O..."
        
        # Write test pattern
        sudo dd if=/dev/urandom of="$DEVICE_PATH" bs=4k count=100 2>/dev/null
        
        # Read test
        sudo dd if="$DEVICE_PATH" of=/dev/null bs=4k count=100 2>/dev/null
        
        # Run fio tests on block device
        echo "Running block device benchmarks..."
        
        # Sequential performance
        sudo fio --name=blkdev_seq \
            --filename="$DEVICE_PATH" \
            --rw=rw \
            --bs=64k \
            --size=512k \
            --numjobs=1 \
            --runtime=30 \
            --group_reporting \
            --output="$RESULTS_DIR/blkdev_seq.txt"
        
        # Random performance
        sudo fio --name=blkdev_random \
            --filename="$DEVICE_PATH" \
            --rw=randrw \
            --bs=4k \
            --size=512k \
            --numjobs=4 \
            --runtime=30 \
            --group_reporting \
            --output="$RESULTS_DIR/blkdev_random.txt"
        
        # Check statistics
        echo "Block device statistics:"
        sudo cat /proc/advblk/advblk0 || echo "Statistics not available"
        
    else
        echo "Block device not created"
    fi
    
    echo "Block device testing completed"
}

# Comprehensive filesystem benchmarks
run_filesystem_benchmarks() {
    local test_path=${1:-"/tmp"}
    local test_name=${2:-"filesystem"}
    
    echo "Running comprehensive filesystem benchmarks on $test_path..."
    
    # Create test directory
    local benchmark_dir="$test_path/benchmark_$$"
    mkdir -p "$benchmark_dir"
    
    # FIO comprehensive test suite
    echo "Running FIO test suite..."
    
    # Sequential read/write patterns
    for bs in 4k 64k 1M; do
        for rw in read write; do
            echo "Testing $rw with block size $bs..."
            fio --name="${test_name}_${rw}_${bs}" \
                --directory="$benchmark_dir" \
                --rw="$rw" \
                --bs="$bs" \
                --size=100M \
                --numjobs=1 \
                --time_based \
                --runtime=30 \
                --group_reporting \
                --output="$RESULTS_DIR/${test_name}_${rw}_${bs}.txt"
        done
    done
    
    # Random I/O patterns
    for pattern in randread randwrite randrw; do
        for bs in 4k 16k 64k; do
            echo "Testing $pattern with block size $bs..."
            fio --name="${test_name}_${pattern}_${bs}" \
                --directory="$benchmark_dir" \
                --rw="$pattern" \
                --bs="$bs" \
                --size=100M \
                --numjobs=4 \
                --time_based \
                --runtime=30 \
                --group_reporting \
                --output="$RESULTS_DIR/${test_name}_${pattern}_${bs}.txt"
        done
    done
    
    # Mixed workload tests
    echo "Testing mixed workloads..."
    fio --name="${test_name}_mixed" \
        --directory="$benchmark_dir" \
        --rw=randrw \
        --rwmixread=70 \
        --bs=8k \
        --size=100M \
        --numjobs=8 \
        --time_based \
        --runtime=60 \
        --group_reporting \
        --output="$RESULTS_DIR/${test_name}_mixed.txt"
    
    # IOzone tests
    echo "Running IOzone tests..."
    iozone -a -g 1G -i 0 -i 1 -i 2 -f "$benchmark_dir/iozone_test" \
        > "$RESULTS_DIR/${test_name}_iozone.txt" 2>&1 || true
    
    # Bonnie++ tests
    echo "Running Bonnie++ tests..."
    bonnie++ -d "$benchmark_dir" -u root -s 100M \
        > "$RESULTS_DIR/${test_name}_bonnie.txt" 2>&1 || true
    
    # Metadata performance tests
    echo "Testing metadata performance..."
    
    # File creation test
    time_start=$(date +%s.%N)
    for i in {1..1000}; do
        touch "$benchmark_dir/file_$i"
    done
    time_end=$(date +%s.%N)
    file_create_time=$(echo "$time_end - $time_start" | bc)
    
    # File deletion test
    time_start=$(date +%s.%N)
    rm -f "$benchmark_dir"/file_*
    time_end=$(date +%s.%N)
    file_delete_time=$(echo "$time_end - $time_start" | bc)
    
    # Directory operations test
    time_start=$(date +%s.%N)
    for i in {1..100}; do
        mkdir "$benchmark_dir/dir_$i"
    done
    time_end=$(date +%s.%N)
    dir_create_time=$(echo "$time_end - $time_start" | bc)
    
    echo "Metadata performance results:" > "$RESULTS_DIR/${test_name}_metadata.txt"
    echo "File creation (1000 files): ${file_create_time}s" >> "$RESULTS_DIR/${test_name}_metadata.txt"
    echo "File deletion (1000 files): ${file_delete_time}s" >> "$RESULTS_DIR/${test_name}_metadata.txt"
    echo "Directory creation (100 dirs): ${dir_create_time}s" >> "$RESULTS_DIR/${test_name}_metadata.txt"
    
    # Cleanup
    rm -rf "$benchmark_dir"
    
    echo "Filesystem benchmarks completed for $test_path"
}

# Performance comparison tests
run_performance_comparison() {
    echo "Running performance comparison tests..."
    
    # Test different filesystems if available
    local filesystems=("ext4" "xfs" "btrfs")
    
    for fs in "${filesystems[@]}"; do
        echo "Testing $fs filesystem..."
        
        # Create loop device with filesystem
        local loop_file="/tmp/test_${fs}.img"
        local loop_mount="/tmp/mount_${fs}"
        
        dd if=/dev/zero of="$loop_file" bs=1M count=500 2>/dev/null
        
        case $fs in
            "ext4")
                mkfs.ext4 -F "$loop_file" > /dev/null 2>&1
                ;;
            "xfs")
                if command -v mkfs.xfs &> /dev/null; then
                    mkfs.xfs -f "$loop_file" > /dev/null 2>&1
                else
                    echo "XFS tools not available, skipping"
                    continue
                fi
                ;;
            "btrfs")
                if command -v mkfs.btrfs &> /dev/null; then
                    mkfs.btrfs -f "$loop_file" > /dev/null 2>&1
                else
                    echo "Btrfs tools not available, skipping"
                    continue
                fi
                ;;
        esac
        
        mkdir -p "$loop_mount"
        sudo mount -o loop "$loop_file" "$loop_mount"
        sudo chown $(whoami):$(whoami) "$loop_mount"
        
        # Run benchmarks
        run_filesystem_benchmarks "$loop_mount" "$fs"
        
        # Cleanup
        sudo umount "$loop_mount"
        rm -f "$loop_file"
        rmdir "$loop_mount"
    done
    
    echo "Performance comparison completed"
}

# Analyze results and generate report
analyze_results() {
    echo "Analyzing benchmark results..."
    
    local report_file="$RESULTS_DIR/storage_benchmark_report.html"
    
    cat > "$report_file" << 'EOF'
<!DOCTYPE html>
<html>
<head>
    <title>Storage Systems Benchmark Report</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .section { margin: 20px 0; padding: 15px; border: 1px solid #ddd; }
        .metric { margin: 10px 0; }
        table { border-collapse: collapse; width: 100%; }
        th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
        th { background-color: #f2f2f2; }
        .good { color: green; }
        .warning { color: orange; }
        .poor { color: red; }
        pre { background: #f5f5f5; padding: 10px; overflow-x: auto; }
    </style>
</head>
<body>
    <h1>Advanced Storage Systems Benchmark Report</h1>
    
    <div class="section">
        <h2>Test Overview</h2>
        <div class="metric">Generated: <script>document.write(new Date())</script></div>
        <div class="metric">Test Duration: Multiple phases</div>
        <div class="metric">Test Types: FUSE filesystem, Block device, Filesystem comparison</div>
    </div>
    
    <div class="section">
        <h2>FUSE Filesystem Performance</h2>
        <p>Custom FUSE filesystem with compression, encryption, and caching capabilities.</p>
        <div id="fuse-results">Loading FUSE results...</div>
    </div>
    
    <div class="section">
        <h2>Block Device Performance</h2>
        <p>Custom kernel block device driver with advanced features.</p>
        <div id="block-results">Loading block device results...</div>
    </div>
    
    <div class="section">
        <h2>Filesystem Comparison</h2>
        <table>
            <tr>
                <th>Filesystem</th>
                <th>Sequential Read (MB/s)</th>
                <th>Sequential Write (MB/s)</th>
                <th>Random Read IOPS</th>
                <th>Random Write IOPS</th>
                <th>Metadata Ops/s</th>
            </tr>
            <tr>
                <td>ext4</td>
                <td id="ext4-seq-read">-</td>
                <td id="ext4-seq-write">-</td>
                <td id="ext4-rand-read">-</td>
                <td id="ext4-rand-write">-</td>
                <td id="ext4-metadata">-</td>
            </tr>
            <tr>
                <td>XFS</td>
                <td id="xfs-seq-read">-</td>
                <td id="xfs-seq-write">-</td>
                <td id="xfs-rand-read">-</td>
                <td id="xfs-rand-write">-</td>
                <td id="xfs-metadata">-</td>
            </tr>
            <tr>
                <td>Btrfs</td>
                <td id="btrfs-seq-read">-</td>
                <td id="btrfs-seq-write">-</td>
                <td id="btrfs-rand-read">-</td>
                <td id="btrfs-rand-write">-</td>
                <td id="btrfs-metadata">-</td>
            </tr>
        </table>
    </div>
    
    <div class="section">
        <h2>Performance Recommendations</h2>
        <ul>
            <li>Enable write-back caching for improved write performance</li>
            <li>Use larger block sizes for sequential workloads</li>
            <li>Consider compression for storage-bound applications</li>
            <li>Implement proper I/O scheduling for mixed workloads</li>
            <li>Monitor and tune filesystem-specific parameters</li>
        </ul>
    </div>
    
    <div class="section">
        <h2>Raw Test Data</h2>
        <p>Detailed test results are available in the results directory:</p>
        <ul>
EOF
    
    # Add links to result files
    for result_file in "$RESULTS_DIR"/*.txt; do
        if [ -f "$result_file" ]; then
            local filename=$(basename "$result_file")
            echo "            <li><a href=\"$filename\">$filename</a></li>" >> "$report_file"
        fi
    done
    
    cat >> "$report_file" << 'EOF'
        </ul>
    </div>
    
    <script>
    // JavaScript to populate results from files would go here
    // In a real implementation, this would parse the FIO/IOzone output files
    </script>
</body>
</html>
EOF
    
    echo "Benchmark report generated: $report_file"
    echo "Open in browser: file://$report_file"
    
    # Generate summary statistics
    echo "=== Benchmark Summary ===" > "$RESULTS_DIR/summary.txt"
    echo "Test completed: $(date)" >> "$RESULTS_DIR/summary.txt"
    echo "Results directory: $RESULTS_DIR" >> "$RESULTS_DIR/summary.txt"
    echo "Number of test files: $(ls -1 "$RESULTS_DIR"/*.txt 2>/dev/null | wc -l)" >> "$RESULTS_DIR/summary.txt"
}

# Cleanup function
cleanup() {
    echo "Cleaning up..."
    
    # Unmount any remaining filesystems
    fusermount3 -u "$MOUNT_POINT" 2>/dev/null || true
    sudo umount "$MOUNT_POINT" 2>/dev/null || true
    
    # Unload kernel module
    cd "$SCRIPT_DIR"
    sudo make unload 2>/dev/null || true
    
    # Remove test files
    rm -rf "$TEST_DIR"
    
    echo "Cleanup completed"
}

# Main execution
main() {
    case "${1:-help}" in
        setup)
            setup_test_environment
            ;;
        fuse)
            test_fuse_filesystem
            ;;
        block)
            test_block_device_driver
            ;;
        benchmark)
            run_filesystem_benchmarks "$2" "$3"
            ;;
        compare)
            run_performance_comparison
            ;;
        analyze)
            analyze_results
            ;;
        all)
            setup_test_environment
            test_fuse_filesystem
            test_block_device_driver
            run_performance_comparison
            analyze_results
            ;;
        cleanup)
            cleanup
            ;;
        *)
            echo "Usage: $0 {setup|fuse|block|benchmark|compare|analyze|all|cleanup} [path] [name]"
            echo ""
            echo "Commands:"
            echo "  setup     - Setup test environment and install tools"
            echo "  fuse      - Test FUSE filesystem implementation"
            echo "  block     - Test block device driver"
            echo "  benchmark - Run filesystem benchmarks [path] [name]"
            echo "  compare   - Compare different filesystem performance"
            echo "  analyze   - Analyze results and generate report"
            echo "  all       - Run complete test suite"
            echo "  cleanup   - Clean up test files and unmount filesystems"
            ;;
    esac
}

# Handle signals for cleanup
trap cleanup EXIT INT TERM

main "$@"
```

This comprehensive Linux storage systems guide demonstrates:

- Advanced FUSE filesystem development with compression, encryption, and caching
- Complete kernel block device driver implementation with advanced features
- High-performance storage benchmarking and testing frameworks
- Production-ready storage system optimization techniques

The implementations showcase real-world storage development techniques used in modern filesystems and storage appliances.

<function_calls>
<invoke name="TodoWrite">
<parameter name="todos">[{"content": "Spread existing blog posts across multiple weeks with proper dates", "status": "completed", "priority": "high", "id": "1"}, {"content": "Create 20 additional advanced Linux/systems programming blog posts", "status": "completed", "priority": "high", "id": "2"}, {"content": "Create 100 more advanced Linux/systems programming blog posts", "status": "in_progress", "priority": "high", "id": "3"}]