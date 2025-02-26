---
title: "Analyzing Docker Image Compression: Size Optimization Guide"
date: 2025-08-15T09:00:00-06:00
draft: false
tags: ["Docker", "DevOps", "Containers", "Performance", "Optimization", "Storage"]
categories:
- Docker
- DevOps
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to analyze and optimize Docker image compression to reduce storage costs and improve deployment times. Includes practical tools and techniques for measuring and reducing image sizes."
more_link: "yes"
url: "/analyzing-docker-image-compression/"
---

Master the techniques for analyzing and optimizing Docker image sizes to improve deployment efficiency and reduce storage costs.

<!--more-->

# Analyzing Docker Image Compression

## Understanding Docker Image Layers

### 1. Layer Structure Analysis

```bash
# View image layers and sizes
docker history --human --format "{{.Size}}\t{{.CreatedBy}}" image:tag

# Detailed layer information
docker inspect image:tag
```

### 2. Compression Analysis Tools

```bash
#!/bin/bash
# analyze-image-size.sh

analyze_image() {
    local image=$1
    echo "Analyzing image: $image"
    
    # Get compressed size
    compressed_size=$(docker image inspect $image --format='{{.Size}}' | numfmt --to=iec-i)
    
    # Get uncompressed size
    uncompressed_size=$(docker history $image --format "{{.Size}}" | 
                       awk '{if($1!="0B")sum+=$1}END{print sum}' | numfmt --to=iec-i)
    
    echo "Compressed size: $compressed_size"
    echo "Uncompressed size: $uncompressed_size"
}
```

## Size Optimization Techniques

### 1. Multi-Stage Builds

```dockerfile
# Build stage
FROM golang:1.21 AS builder
WORKDIR /app
COPY . .
RUN CGO_ENABLED=0 go build -o myapp

# Final stage
FROM alpine:3.19
COPY --from=builder /app/myapp /
CMD ["/myapp"]
```

### 2. Layer Optimization

```dockerfile
# Bad - Multiple layers
FROM ubuntu:22.04
RUN apt-get update
RUN apt-get install -y python3
RUN apt-get install -y nodejs
RUN rm -rf /var/lib/apt/lists/*

# Good - Single layer
FROM ubuntu:22.04
RUN apt-get update && \
    apt-get install -y \
        python3 \
        nodejs && \
    rm -rf /var/lib/apt/lists/*
```

## Compression Analysis Tools

### 1. Basic Size Analysis

```bash
# Get compressed size
docker images --format "{{.Repository}}:{{.Tag}} - {{.Size}}"

# Calculate total size
docker system df -v
```

### 2. Advanced Analysis Script

```python
#!/usr/bin/env python3
import subprocess
import json

def analyze_image_layers(image):
    cmd = f"docker inspect {image}"
    result = subprocess.run(cmd.split(), capture_output=True, text=True)
    data = json.loads(result.stdout)
    
    layers = data[0]['RootFS']['Layers']
    layer_sizes = []
    
    for layer in layers:
        cmd = f"du -sh /var/lib/docker/overlay2/{layer}"
        size = subprocess.run(cmd.split(), capture_output=True, text=True)
        layer_sizes.append(size.stdout.strip())
    
    return layer_sizes

def main():
    image = "your-image:tag"
    sizes = analyze_image_layers(image)
    print(f"Layer sizes for {image}:")
    for i, size in enumerate(sizes):
        print(f"Layer {i}: {size}")

if __name__ == "__main__":
    main()
```

## Monitoring and Reporting

### 1. Size Tracking Script

```bash
#!/bin/bash
# track-image-sizes.sh

log_file="image_sizes.log"

echo "Date: $(date)" >> $log_file
echo "Image Sizes:" >> $log_file
docker images --format "{{.Repository}}:{{.Tag}}\t{{.Size}}" >> $log_file
echo "-------------------" >> $log_file
```

### 2. Trend Analysis

```python
#!/usr/bin/env python3
import pandas as pd
import matplotlib.pyplot as plt

def analyze_size_trends(log_file):
    data = []
    with open(log_file, 'r') as f:
        lines = f.readlines()
        
    # Parse log file
    current_date = None
    for line in lines:
        if line.startswith('Date:'):
            current_date = line.split(': ')[1].strip()
        elif ':' in line and '\t' in line:
            image, size = line.strip().split('\t')
            data.append({
                'date': current_date,
                'image': image,
                'size': size
            })
    
    return pd.DataFrame(data)

# Generate trend plot
df = analyze_size_trends('image_sizes.log')
df.plot(x='date', y='size', kind='line')
plt.show()
```

## Best Practices

### 1. Base Image Selection

```dockerfile
# Use slim variants when possible
FROM python:3.12-slim

# Or distroless for production
FROM gcr.io/distroless/python3
```

### 2. Cleanup Strategies

```dockerfile
# Clean up in the same layer
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        package1 \
        package2 && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*
```

## Implementation Guide

### 1. Size Analysis Workflow

```bash
#!/bin/bash
# analyze-workflow.sh

# 1. Get base image size
base_size=$(docker images --format "{{.Size}}" python:3.12-slim)

# 2. Build image
docker build -t myapp .

# 3. Get final size
final_size=$(docker images --format "{{.Size}}" myapp)

# 4. Calculate difference
echo "Size increase: $(($final_size - $base_size))"
```

### 2. Optimization Checklist

1. **Base Image**
   - [ ] Use minimal base image
   - [ ] Consider multi-stage builds
   - [ ] Remove unnecessary dependencies

2. **Build Process**
   - [ ] Combine RUN commands
   - [ ] Clean up in same layer
   - [ ] Use .dockerignore

3. **Testing**
   - [ ] Compare sizes before/after
   - [ ] Test functionality
   - [ ] Verify compression ratio

## Automation Tools

### 1. CI/CD Integration

```yaml
# GitLab CI example
image_size_check:
  script:
    - docker build -t $CI_REGISTRY_IMAGE .
    - size=$(docker images $CI_REGISTRY_IMAGE --format "{{.Size}}")
    - |
      if [ "$size" -gt "$MAX_SIZE" ]; then
        echo "Image size $size exceeds limit $MAX_SIZE"
        exit 1
      fi
```

### 2. Monitoring Integration

```python
# Prometheus metrics
from prometheus_client import Gauge

image_size = Gauge('docker_image_size_bytes', 
                  'Docker image size in bytes',
                  ['image', 'tag'])

def update_metrics():
    for image in docker.images.list():
        image_size.labels(
            image=image.tags[0],
            tag=image.tags[0].split(':')[1]
        ).set(image.attrs['Size'])
```

Remember to regularly analyze and optimize your Docker images to maintain efficient deployments and reduce storage costs. Implement automated checks in your CI/CD pipeline to prevent oversized images from being deployed.
