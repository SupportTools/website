---
title: "Apache Precompressed Static Files: Optimizing with gzip"
date: 2025-11-15T09:00:00-06:00
draft: false
tags: ["Apache", "Performance", "Optimization", "Web Server", "Compression", "gzip"]
categories:
- Web Servers
- Performance
- Apache
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to optimize Apache web server performance by implementing precompressed static files with gzip. Includes configuration examples, automation scripts, and performance monitoring techniques."
more_link: "yes"
url: "/apache-precompressed-static-files/"
---

Master the art of optimizing Apache web server performance by implementing precompressed static files with gzip compression.

<!--more-->

# Apache Precompressed Static Files

## Why Precompress Static Files?

Precompressing static files offers several advantages:
- Reduced server CPU usage
- Faster response times
- Lower bandwidth consumption
- Improved scalability
- Better user experience

## Implementation Guide

### 1. Apache Configuration

```apache
# Enable mod_rewrite
RewriteEngine on

# Check for gzip support
RewriteCond %{HTTP:Accept-encoding} gzip

# Check for precompressed file
RewriteCond %{REQUEST_FILENAME}.gz -s
RewriteRule ^(.+)\.(js|css|html|xml|txt)$ $1.$2.gz [QSA,L]

# Set proper content encoding
<FilesMatch "\.js\.gz$">
    ForceType application/javascript
    Header set Content-Encoding gzip
</FilesMatch>

<FilesMatch "\.css\.gz$">
    ForceType text/css
    Header set Content-Encoding gzip
</FilesMatch>

<FilesMatch "\.(html|xml|txt)\.gz$">
    ForceType text/html
    Header set Content-Encoding gzip
</FilesMatch>
```

### 2. Compression Script

```bash
#!/bin/bash
# compress-static.sh

compress_files() {
    local dir=$1
    local file_types=("js" "css" "html" "xml" "txt")
    
    for type in "${file_types[@]}"; do
        find "$dir" -type f -name "*.$type" | while read -r file; do
            if [ ! -f "${file}.gz" ] || [ "$file" -nt "${file}.gz" ]; then
                gzip -9 -c "$file" > "${file}.gz"
                echo "Compressed: $file"
            fi
        done
    done
}

# Usage
compress_files "/var/www/html/static"
```

## Automation and Monitoring

### 1. Automated Compression

```python
#!/usr/bin/env python3
# auto_compress.py

import os
import gzip
import time
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

class CompressHandler(FileSystemEventHandler):
    def __init__(self, extensions):
        self.extensions = extensions
        
    def on_modified(self, event):
        if not event.is_directory:
            file_path = event.src_path
            ext = os.path.splitext(file_path)[1][1:]
            
            if ext in self.extensions and not file_path.endswith('.gz'):
                self.compress_file(file_path)
    
    def compress_file(self, file_path):
        gz_path = f"{file_path}.gz"
        with open(file_path, 'rb') as f_in:
            with gzip.open(gz_path, 'wb', compresslevel=9) as f_out:
                f_out.writelines(f_in)
        print(f"Compressed: {file_path}")

def main():
    path = "/var/www/html/static"
    extensions = {'js', 'css', 'html', 'xml', 'txt'}
    
    event_handler = CompressHandler(extensions)
    observer = Observer()
    observer.schedule(event_handler, path, recursive=True)
    observer.start()
    
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()
    observer.join()

if __name__ == "__main__":
    main()
```

### 2. Performance Monitoring

```python
#!/usr/bin/env python3
# monitor_compression.py

import os
import requests
import time
from datetime import datetime

def check_compression(url):
    # Check with and without gzip support
    headers_nogzip = {'Accept-Encoding': ''}
    headers_gzip = {'Accept-Encoding': 'gzip'}
    
    # Make requests
    resp_nogzip = requests.get(url, headers=headers_nogzip)
    resp_gzip = requests.get(url, headers=headers_gzip)
    
    # Calculate savings
    original_size = len(resp_nogzip.content)
    compressed_size = len(resp_gzip.content)
    savings = ((original_size - compressed_size) / original_size) * 100
    
    return {
        'url': url,
        'original_size': original_size,
        'compressed_size': compressed_size,
        'savings_percent': savings,
        'time': datetime.now()
    }

def log_results(results):
    with open('compression_stats.log', 'a') as f:
        f.write(f"{results['time']}: {results['url']} - "
                f"Savings: {results['savings_percent']:.2f}%\n")
```

## Performance Optimization

### 1. Compression Levels

```bash
# Test different compression levels
for level in {1..9}; do
    echo "Testing compression level $level"
    time gzip -$level -c large.js > large.js.gz
    ls -lh large.js.gz
done
```

### 2. Cache Configuration

```apache
# Set cache headers for compressed files
<FilesMatch "\.(js|css|html|xml|txt)\.gz$">
    Header set Cache-Control "max-age=31536000, public"
    Header unset ETag
    FileETag None
</FilesMatch>
```

## Implementation Scripts

### 1. Initial Setup

```bash
#!/bin/bash
# setup-compression.sh

# Enable required modules
a2enmod rewrite
a2enmod headers

# Create compression directory structure
mkdir -p /var/www/html/static/{js,css,html}

# Set permissions
chown -R www-data:www-data /var/www/html/static
chmod -R 755 /var/www/html/static

# Initial compression
find /var/www/html/static -type f \( -name "*.js" -o -name "*.css" -o -name "*.html" \) \
    -exec gzip -9 -c {} > {}.gz \;
```

### 2. Maintenance Script

```bash
#!/bin/bash
# maintain-compression.sh

# Remove outdated compressed files
find /var/www/html/static -type f -name "*.gz" | while read -r gz_file; do
    original="${gz_file%.gz}"
    if [ ! -f "$original" ]; then
        rm "$gz_file"
        echo "Removed orphaned: $gz_file"
    fi
done

# Update stale compressed files
find /var/www/html/static -type f ! -name "*.gz" | while read -r file; do
    if [ ! -f "${file}.gz" ] || [ "$file" -nt "${file}.gz" ]; then
        gzip -9 -c "$file" > "${file}.gz"
        echo "Updated: ${file}.gz"
    fi
done
```

## Best Practices

1. **File Selection**
   - Compress text-based files
   - Skip already compressed formats
   - Consider file size thresholds

2. **Performance Monitoring**
   - Track compression ratios
   - Monitor server load
   - Measure response times

3. **Maintenance**
   - Regular compression updates
   - Clean up orphaned files
   - Monitor disk usage

Remember to test thoroughly in a staging environment before implementing in production, and monitor server performance to ensure the compression configuration is providing optimal benefits.
