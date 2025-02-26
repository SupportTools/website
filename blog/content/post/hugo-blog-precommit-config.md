---
title: "Pre-commit Configuration for Hugo Blogs: A Complete Guide"
date: 2025-09-15T09:00:00-06:00
draft: false
tags: ["Hugo", "Git", "Pre-commit", "Blogging", "DevOps", "Quality Assurance"]
categories:
- Hugo
- DevOps
- Quality Assurance
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to implement robust pre-commit hooks for your Hugo blog to ensure content quality, formatting consistency, and prevent common errors before they reach your repository."
more_link: "yes"
url: "/hugo-blog-precommit-config/"
---

Master the art of maintaining high-quality Hugo blog content with automated pre-commit checks and validations.

<!--more-->

# Pre-commit Configuration for Hugo Blogs

## Why Use Pre-commit Hooks?

Pre-commit hooks provide several benefits for Hugo blogs:
- Ensure content quality
- Maintain consistent formatting
- Catch errors early
- Automate routine checks
- Enforce style guidelines

## Basic Setup

### 1. Install Pre-commit

```bash
# Using pip
pip install pre-commit

# Using Homebrew
brew install pre-commit
```

### 2. Initial Configuration

Create `.pre-commit-config.yaml`:

```yaml
repos:
  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v4.5.0
    hooks:
      - id: trailing-whitespace
      - id: end-of-file-fixer
      - id: check-yaml
      - id: check-added-large-files

  - repo: local
    hooks:
      - id: hugo-lint
        name: Hugo Lint
        entry: hugo
        args: ["-D", "--gc", "--minify"]
        language: system
        pass_filenames: false
```

## Hugo-Specific Checks

### 1. Content Validation

```yaml
  - repo: local
    hooks:
      - id: check-frontmatter
        name: Check Frontmatter
        entry: python
        language: system
        files: ^content/.*\.md$
        args:
          - -c
          - |
            import sys
            import yaml
            import frontmatter
            
            def validate_frontmatter(file_path):
                try:
                    post = frontmatter.load(file_path)
                    required_fields = ['title', 'date', 'description']
                    for field in required_fields:
                        if field not in post.metadata:
                            print(f"Missing required field: {field}")
                            return 1
                    return 0
                except Exception as e:
                    print(f"Error processing {file_path}: {str(e)}")
                    return 1
            
            exit(validate_frontmatter(sys.argv[1]))
```

### 2. Link Checking

```yaml
  - repo: local
    hooks:
      - id: check-links
        name: Check Internal Links
        entry: python
        language: system
        files: ^content/.*\.md$
        args:
          - -c
          - |
            import re
            import sys
            
            def check_links(file_path):
                with open(file_path, 'r') as f:
                    content = f.read()
                
                internal_links = re.findall(r'\[.*?\]\(((?!http).*?)\)', content)
                errors = []
                
                for link in internal_links:
                    if not os.path.exists(os.path.join('content', link.lstrip('/'))):
                        errors.append(f"Broken internal link: {link}")
                
                if errors:
                    print("\n".join(errors))
                    return 1
                return 0
            
            exit(check_links(sys.argv[1]))
```

## Advanced Configurations

### 1. Image Optimization

```yaml
  - repo: local
    hooks:
      - id: optimize-images
        name: Optimize Images
        entry: bash
        language: system
        files: \.(jpg|jpeg|png|gif)$
        args:
          - -c
          - |
            for file in "$@"; do
              if [[ "$file" =~ \.(jpg|jpeg)$ ]]; then
                jpegoptim --strip-all --max=85 "$file"
              elif [[ "$file" =~ \.png$ ]]; then
                optipng -o5 "$file"
              fi
            done
```

### 2. Content Quality Checks

```yaml
  - repo: local
    hooks:
      - id: check-content-quality
        name: Content Quality Check
        entry: python
        language: system
        files: ^content/.*\.md$
        args:
          - -c
          - |
            import sys
            import re
            
            def check_quality(file_path):
                with open(file_path, 'r') as f:
                    content = f.read()
                
                checks = {
                    'min_length': len(content) > 500,
                    'has_headings': bool(re.search(r'^##\s', content, re.M)),
                    'has_code_blocks': '```' in content
                }
                
                failed = [k for k, v in checks.items() if not v]
                if failed:
                    print(f"Failed checks: {', '.join(failed)}")
                    return 1
                return 0
            
            exit(check_quality(sys.argv[1]))
```

## Custom Validations

### 1. SEO Optimization Check

```python
#!/usr/bin/env python3
# seo_check.py

import frontmatter
import sys

def check_seo(file_path):
    post = frontmatter.load(file_path)
    checks = {
        'title_length': 20 <= len(post.metadata.get('title', '')) <= 60,
        'description_length': 50 <= len(post.metadata.get('description', '')) <= 160,
        'has_tags': bool(post.metadata.get('tags', [])),
        'has_categories': bool(post.metadata.get('categories', []))
    }
    
    failed = [k for k, v in checks.items() if not v]
    if failed:
        print(f"SEO checks failed: {', '.join(failed)}")
        return 1
    return 0

if __name__ == "__main__":
    sys.exit(check_seo(sys.argv[1]))
```

### 2. Style Guide Enforcement

```python
#!/usr/bin/env python3
# style_check.py

import re
import sys

def check_style(file_path):
    with open(file_path, 'r') as f:
        content = f.read()
    
    rules = {
        'no_double_spaces': not re.search(r'[^\n]  +[^\n]', content),
        'proper_headings': all(h.startswith(' ') for h in re.findall(r'^#.*$', content, re.M)),
        'code_block_language': all('```' not in b or re.match(r'```\w+', b) 
                                 for b in re.findall(r'```.*?```', content, re.S))
    }
    
    failed = [k for k, v in rules.items() if not v]
    if failed:
        print(f"Style checks failed: {', '.join(failed)}")
        return 1
    return 0

if __name__ == "__main__":
    sys.exit(check_style(sys.argv[1]))
```

## Implementation Guide

### 1. Setup Process

```bash
# Initialize pre-commit
pre-commit install

# Create hook scripts directory
mkdir -p .git/hooks/scripts

# Copy custom scripts
cp seo_check.py .git/hooks/scripts/
cp style_check.py .git/hooks/scripts/
chmod +x .git/hooks/scripts/*
```

### 2. Testing Configuration

```bash
# Test all files
pre-commit run --all-files

# Test specific hooks
pre-commit run check-frontmatter --all-files
pre-commit run check-links --all-files
```

## Best Practices

1. **Configuration Management**
   - Version control hooks
   - Document custom scripts
   - Share team standards

2. **Performance**
   - Optimize heavy checks
   - Use caching when possible
   - Run expensive checks selectively

3. **Maintenance**
   - Regular updates
   - Monitor false positives
   - Adjust thresholds as needed

Remember to customize these checks based on your specific blog requirements and team workflow. Regular reviews and updates ensure the pre-commit hooks continue to serve their purpose effectively.
