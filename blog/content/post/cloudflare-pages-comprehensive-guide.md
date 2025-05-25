---
title: "Cloudflare Pages: The Complete Guide to Building and Deploying JAMstack Applications"
date: 2025-12-02T09:00:00-05:00
draft: false
tags: ["Cloudflare", "Cloudflare Pages", "JAMstack", "Static Sites", "Web Development", "Workers", "KV", "R2", "Terraform", "CDN"]
categories:
- Web Development
- Cloudflare
- Deployment
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Cloudflare Pages for deploying and scaling JAMstack applications with advanced features like Workers, KV Namespace, R2 Storage, and automated deployment workflows."
more_link: "yes"
url: "/cloudflare-pages-comprehensive-guide/"
---

![Cloudflare Pages Architecture](/images/posts/cloudflare/cloudflare-pages-architecture.svg)

Cloudflare Pages offers a powerful platform for deploying static sites and JAMstack applications with global CDN distribution, Git integration, and advanced features. This comprehensive guide explores everything from basic deployments to advanced implementations with Workers, KV, and R2, including automation with Terraform.

<!--more-->

# [Cloudflare Pages: Comprehensive Implementation Guide](#cloudflare-pages)

## [Introduction to Cloudflare Pages](#introduction)

Cloudflare Pages represents a paradigm shift in how developers deploy and scale static websites and JAMstack applications. Built on Cloudflare's global network spanning over 275 cities worldwide, Pages combines the simplicity of static site deployments with the power of edge computing capabilities.

### [What is Cloudflare Pages?](#what-is-pages)

Cloudflare Pages is a platform for deploying static websites and JAMstack applications directly from Git repositories. It provides:

1. **Seamless Git Integration**: Automatic builds and deployments from GitHub or GitLab repositories
2. **Global CDN**: Content delivery from Cloudflare's expansive edge network
3. **Preview Deployments**: Unique URLs for each branch or pull request
4. **Zero Configuration SSL**: Automatic HTTPS for all sites and preview deployments
5. **Unlimited Bandwidth**: No bandwidth restrictions or overage charges

### [How Pages Compares to Other Platforms](#platform-comparison)

| Feature | Cloudflare Pages | Netlify | Vercel | GitHub Pages |
|---------|------------------|---------|--------|--------------|
| Global CDN | ✅ (275+ cities) | ✅ (Limited) | ✅ (Limited) | ✅ (Limited) |
| Build Minutes | Free tier: 500/month | Free tier: 300/month | Free tier: 6000/month (shared) | Limited |
| Preview Deployments | ✅ | ✅ | ✅ | ❌ |
| Edge Functions | ✅ (Workers) | ✅ (Limited) | ✅ | ❌ |
| Storage Solutions | ✅ (KV, R2, D1) | ✅ (Limited) | ✅ (Limited) | ❌ |
| Custom Domains | ✅ Unlimited | Limited on free tier | Limited on free tier | Limited |
| Analytics | ✅ (Web Analytics) | ✅ | ✅ | Limited |
| Bandwidth | Unlimited | Limited on free tier | Limited on free tier | Limited |

Cloudflare's edge computing capabilities and global network provide distinct advantages for applications requiring low latency and high performance worldwide.

## [Getting Started with Cloudflare Pages](#getting-started)

### [Setting Up Your First Project](#first-project)

To deploy your first Cloudflare Pages project:

1. **Create a Cloudflare Account**:
   - Sign up at [dash.cloudflare.com](https://dash.cloudflare.com)
   - No credit card required for basic features

2. **Connect Your Git Repository**:
   - Navigate to Pages in your Cloudflare dashboard
   - Click "Create a project"
   - Connect to GitHub or GitLab
   - Select your repository

3. **Configure Build Settings**:
   ```
   Build command: npm run build
   Build output directory: dist
   ```

4. **Deploy Your Site**:
   - Click "Save and Deploy"
   - Cloudflare handles the build process and deployment

### [Common Framework Configurations](#framework-configurations)

Cloudflare Pages seamlessly supports popular frameworks with zero configuration:

**React (Create React App)**:
```
Build command: npm run build
Build output directory: build
```

**Vue.js**:
```
Build command: npm run build
Build output directory: dist
```

**Next.js**:
```
Build command: npm run build && npm run export
Build output directory: out
```

**Gatsby**:
```
Build command: npm run build
Build output directory: public
```

**Hugo**:
```
Build command: hugo
Build output directory: public
```

**Jekyll**:
```
Build command: jekyll build
Build output directory: _site
```

### [Environment Variables and Build Configuration](#environment-variables)

Configure environment variables for your build process:

1. **Production Variables**: Apply to main branch deployments
2. **Preview Variables**: Apply to all other deployments

Example for a React application with different API endpoints:

```
# Production environment
REACT_APP_API_URL=https://api.production.example.com

# Preview environment
REACT_APP_API_URL=https://api.staging.example.com
```

## [Advanced Cloudflare Pages Features](#advanced-features)

Cloudflare Pages becomes truly powerful when combined with other Cloudflare products.

### [Workers Integration](#workers-integration)

[Cloudflare Workers](https://workers.cloudflare.com/) are serverless JavaScript functions that run at the edge. They enable server-side functionality for your static Pages site.

#### [Functions Directory](#functions-directory)

Create a `/functions` directory in your project to automatically deploy Workers:

```
my-project/
├── functions/
│   ├── api/
│   │   └── users.js
│   └── hello.js
└── ...
```

Example Worker function (`hello.js`):

```javascript
export default {
  async fetch(request, env) {
    return new Response("Hello, World!");
  }
};
```

Access this function at `your-site.pages.dev/hello`.

#### [API Routes](#api-routes)

Create API endpoints by organizing functions in subdirectories:

```javascript
// functions/api/users.js
export async function onRequest(context) {
  return new Response(JSON.stringify({
    users: [
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" }
    ]
  }), {
    headers: {
      "Content-Type": "application/json"
    }
  });
}
```

Access this API at `your-site.pages.dev/api/users`.

### [KV Namespace Integration](#kv-integration)

[Workers KV](https://developers.cloudflare.com/workers/learning/how-kv-works/) provides a global, low-latency key-value data store.

#### [Binding KV to Your Pages Project](#kv-binding)

1. Create a KV namespace in the Cloudflare dashboard
2. Bind it to your Pages project
3. Access it in your Worker functions

```javascript
// functions/counter.js
export async function onRequest({ env }) {
  // Read current count
  let count = await env.MY_KV.get("visitor_count");
  count = (parseInt(count) || 0) + 1;
  
  // Update count
  await env.MY_KV.put("visitor_count", count.toString());
  
  return new Response(`Visitor count: ${count}`);
}
```

#### [Common KV Use Cases](#kv-use-cases)

1. **User Preferences**: Store user settings globally
2. **Content Caching**: Cache API responses for faster access
3. **Feature Flags**: Toggle features based on environment
4. **Session Management**: Store session data without cookies
5. **Counters and Statistics**: Track simple metrics

### [R2 Storage Integration](#r2-integration)

[Cloudflare R2](https://developers.cloudflare.com/r2/) provides S3-compatible object storage without egress fees.

#### [Binding R2 to Your Pages Project](#r2-binding)

1. Create an R2 bucket in the Cloudflare dashboard
2. Bind it to your Pages project
3. Access it in your Worker functions

```javascript
// functions/upload.js
export async function onRequest(context) {
  const { request, env } = context;
  
  if (request.method === "POST") {
    const formData = await request.formData();
    const file = formData.get('file');
    
    if (file) {
      // Upload to R2
      await env.MY_BUCKET.put(file.name, file);
      return new Response("File uploaded successfully");
    }
  }
  
  return new Response("Please send a file", { status: 400 });
}
```

#### [Serving Assets from R2](#serving-r2-assets)

Create a Worker to serve assets from R2:

```javascript
// functions/assets/[file].js
export async function onRequest(context) {
  const { request, env, params } = context;
  const fileName = params.file;
  
  try {
    // Get object from R2
    const object = await env.MY_BUCKET.get(fileName);
    
    if (object === null) {
      return new Response("File not found", { status: 404 });
    }
    
    // Determine content type
    const contentType = getContentType(fileName);
    
    // Return the file
    return new Response(object.body, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400"
      }
    });
  } catch (e) {
    return new Response("Error fetching file", { status: 500 });
  }
}

function getContentType(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const types = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    pdf: 'application/pdf',
    // Add more as needed
  };
  return types[ext] || 'application/octet-stream';
}
```

### [Durable Objects for Stateful Applications](#durable-objects)

[Durable Objects](https://developers.cloudflare.com/workers/learning/using-durable-objects/) provide consistency and coordination for stateful applications.

Example chat application using Durable Objects:

```javascript
// ChatRoom.js
export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage;
    this.sessions = [];
  }
  
  async fetch(request) {
    // WebSocket upgrade
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      
      server.accept();
      
      // Store the WebSocket
      const session = { webSocket: server };
      this.sessions.push(session);
      
      // Handle messages and disconnects...
      
      return new Response(null, {
        status: 101,
        webSocket: client
      });
    }
    
    return new Response("Expected WebSocket", { status: 400 });
  }
}
```

### [D1 Database Integration](#d1-integration)

[D1](https://developers.cloudflare.com/d1/) is Cloudflare's serverless SQL database, perfect for Pages applications.

```javascript
// functions/api/posts.js
export async function onRequest(context) {
  const { env, params } = context;
  
  // Query the database
  const { results } = await env.DB.prepare(
    "SELECT * FROM posts ORDER BY created_at DESC LIMIT 10"
  ).all();
  
  return new Response(JSON.stringify({ posts: results }), {
    headers: { "Content-Type": "application/json" }
  });
}
```

## [Implementing Custom Domains and SSL](#custom-domains)

Every Cloudflare Pages site includes a default `*.pages.dev` domain. For production applications, you'll want to use a custom domain.

### [Adding a Custom Domain](#adding-domain)

1. Navigate to your Pages project
2. Click "Custom domains"
3. Enter your domain name
4. Verify domain ownership

For domains already on Cloudflare:

- Verification is automatic
- DNS records are created automatically

For external domains:

- Follow the verification steps
- Add DNS records manually

### [SSL Configuration](#ssl-configuration)

Cloudflare Pages provides automatic SSL certificates for all domains:

1. **Full SSL**: Encrypts traffic between visitors and Cloudflare, and between Cloudflare and your origin
2. **Full (Strict)**: Same as Full, but requires a valid certificate on your origin
3. **Flexible**: Encrypts traffic between visitors and Cloudflare only (not recommended)

Configuration:

1. Navigate to SSL/TLS section in your Cloudflare dashboard
2. Select desired encryption mode
3. Enable HSTS for enhanced security (optional)

## [Optimizing Performance with Pages](#performance-optimization)

Cloudflare Pages includes powerful optimizations by default, but you can enhance performance further.

### [Asset Optimization](#asset-optimization)

1. **Automatic Minification**:
   - Navigate to Speed > Optimization
   - Enable minification for HTML, CSS, and JavaScript

2. **Image Optimization**:
   - Use Cloudflare Images for responsive and optimized images
   - Example implementation:

```html
<img src="https://imagedelivery.net/your-account/your-image/public" 
     srcset="https://imagedelivery.net/your-account/your-image/300w 300w,
             https://imagedelivery.net/your-account/your-image/600w 600w"
     sizes="(max-width: 600px) 300px, 600px"
     loading="lazy"
     alt="Optimized image">
```

### [Caching Strategies](#caching-strategies)

1. **Browser TTL**:
   - Navigate to Caching > Configuration
   - Set Browser Cache TTL to appropriate value

2. **Edge Caching**:
   - Fine-tune with Page Rules or Cache Rules
   - Example Cache Rule:

```
When: URL path matches /assets/*
Then: Edge Cache TTL: 7 days
```

3. **API Response Caching**:
   - Cache API responses with Workers:

```javascript
export async function onRequest(context) {
  // Create a cache key based on the URL
  const cacheKey = new URL(context.request.url);
  
  // Check cache first
  const cache = caches.default;
  let response = await cache.match(cacheKey);
  
  if (!response) {
    // Fetch data from origin
    response = await fetch("https://api.example.com/data");
    
    // Clone the response to modify headers
    const responseToCache = new Response(response.body, response);
    responseToCache.headers.set("Cache-Control", "public, max-age=3600");
    
    // Store in cache
    await cache.put(cacheKey, responseToCache);
  }
  
  return response;
}
```

### [Performance Monitoring](#performance-monitoring)

1. **Cloudflare Web Analytics**:
   - Enable in dashboard
   - Zero impact on performance
   - No cookies or personal data collection

2. **Core Web Vitals Monitoring**:
   - Track LCP, FID, and CLS
   - Make data-driven optimizations

## [Automating Pages Deployment with Terraform](#terraform-automation)

Automate your Cloudflare Pages deployments using Infrastructure as Code with Terraform.

### [Terraform Provider Configuration](#terraform-provider)

```hcl
terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.23"
    }
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}
```

### [Creating a Pages Project](#terraform-pages-project)

```hcl
resource "cloudflare_pages_project" "my_site" {
  account_id        = var.cloudflare_account_id
  name              = "my-project"
  production_branch = "main"

  source {
    type = "github"
    config {
      owner                      = "your-github-username"
      repo_name                  = "your-repo-name"
      production_branch          = "main"
      pr_comments_enabled        = true
      deployments_enabled        = true
      preview_deployment_setting = "all"
      preview_branch_includes    = ["dev", "staging"]
    }
  }

  build_config {
    build_command   = "npm run build"
    destination_dir = "dist"
    root_dir        = ""
  }
}
```

### [Configuring KV Namespace with Terraform](#terraform-kv)

```hcl
resource "cloudflare_workers_kv_namespace" "my_namespace" {
  title = "my-kv-namespace"
}

# Add a KV binding to the Pages project
resource "cloudflare_pages_project" "my_site" {
  # ... other configuration ...

  deployment_configs {
    preview {
      kv_namespaces = {
        MY_KV = cloudflare_workers_kv_namespace.my_namespace.id
      }
    }
    production {
      kv_namespaces = {
        MY_KV = cloudflare_workers_kv_namespace.my_namespace.id
      }
    }
  }
}
```

### [Configuring R2 with Terraform](#terraform-r2)

```hcl
resource "cloudflare_r2_bucket" "assets_bucket" {
  account_id = var.cloudflare_account_id
  name       = "my-assets-bucket"
}

# Add an R2 binding to the Pages project
resource "cloudflare_pages_project" "my_site" {
  # ... other configuration ...

  deployment_configs {
    preview {
      r2_buckets = {
        MY_BUCKET = cloudflare_r2_bucket.assets_bucket.name
      }
    }
    production {
      r2_buckets = {
        MY_BUCKET = cloudflare_r2_bucket.assets_bucket.name
      }
    }
  }
}
```

### [Setting Environment Variables](#terraform-env-vars)

```hcl
resource "cloudflare_pages_project" "my_site" {
  # ... other configuration ...

  deployment_configs {
    preview {
      environment_variables = {
        API_URL     = "https://api.staging.example.com"
        DEBUG       = "true"
        NODE_VERSION = "18"
      }
    }
    production {
      environment_variables = {
        API_URL     = "https://api.example.com"
        DEBUG       = "false"
        NODE_VERSION = "18"
      }
    }
  }
}
```

### [Custom Domain Configuration](#terraform-custom-domains)

```hcl
resource "cloudflare_record" "pages_cname" {
  zone_id = var.cloudflare_zone_id
  name    = "www"
  value   = "${cloudflare_pages_project.my_site.name}.pages.dev"
  type    = "CNAME"
  proxied = true
}

resource "cloudflare_pages_domain" "custom_domain" {
  account_id   = var.cloudflare_account_id
  project_name = cloudflare_pages_project.my_site.name
  domain       = "www.example.com"

  depends_on = [cloudflare_record.pages_cname]
}
```

## [Real-World Architectures with Pages](#real-world-architectures)

### [E-commerce JAMstack Architecture](#ecommerce-architecture)

```
┌───────────────────┐      ┌───────────────────┐
│                   │      │                   │
│   Cloudflare      │      │   Admin Panel     │
│   Pages           │      │   (Headless CMS)  │
│                   │      │                   │
└─────────┬─────────┘      └─────────┬─────────┘
          │                          │
          ▼                          ▼
┌───────────────────┐      ┌───────────────────┐
│                   │      │                   │
│   Pages Functions │      │   Content API     │
│   (Workers)       │◄─────┤   (GraphQL)       │
│                   │      │                   │
└─────────┬─────────┘      └─────────┬─────────┘
          │                          │
          ▼                          ▼
┌───────────────────┐      ┌───────────────────┐
│                   │      │                   │
│   R2 Storage      │      │   D1 Database     │
│   (Product Images)│      │   (Product Data)  │
│                   │      │                   │
└───────────────────┘      └───────────────────┘
```

Key components:

1. **Static Frontend**: E-commerce UI built with React or Vue.js
2. **Worker Functions**: Handle cart, user sessions, and payment processing
3. **KV**: Store cart data and user preferences
4. **R2**: Store and serve product images efficiently
5. **D1**: Store product and inventory data

### [SaaS Application Architecture](#saas-architecture)

```
┌───────────────────┐      ┌───────────────────┐
│                   │      │                   │
│   Cloudflare      │      │   Authentication  │
│   Pages           │◄─────┤   (Cloudflare     │
│   (SPA Frontend)  │      │   Access)         │
│                   │      │                   │
└─────────┬─────────┘      └───────────────────┘
          │                          
          ▼                          
┌───────────────────┐      ┌───────────────────┐
│                   │      │                   │
│   Pages Functions │◄─────┤   Third-party     │
│   (API Layer)     │      │   APIs            │
│                   │      │                   │
└─────────┬─────────┘      └───────────────────┘
          │                          
          ▼                          
┌───────────────────┐      ┌───────────────────┐
│                   │      │                   │
│   Durable Objects │      │   KV Namespace    │
│   (User State)    │      │   (Cached Data)   │
│                   │      │                   │
└───────────────────┘      └───────────────────┘
```

Key components:

1. **Secure SPA**: React/Angular/Vue application with authentication
2. **Worker API**: Serverless backend functions
3. **Durable Objects**: Maintain user state and session consistency
4. **KV**: Store and cache frequently accessed data

## [Common Challenges and Solutions](#challenges-solutions)

### [Build Failures](#build-failures)

**Challenge**: Pages build fails despite working locally

**Solutions**:

1. **Node.js Version**:
   ```
   # Add to environment variables
   NODE_VERSION=18
   ```

2. **Missing Dependencies**:
   ```json
   // package.json
   "dependencies": {
     "dependency-needed-for-build": "^1.0.0"
   }
   ```

3. **Build Command Issues**:
   - Verify build command matches your project configuration
   - Check that output directory is correctly specified

### [Cache Invalidation](#cache-invalidation)

**Challenge**: Updates not immediately visible after deployment

**Solutions**:

1. **Cache Purge API**:
   ```javascript
   // functions/purge-cache.js
   export async function onRequest(context) {
     try {
       const response = await fetch(
         `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/purge_cache`,
         {
           method: 'POST',
           headers: {
             'Content-Type': 'application/json',
             'Authorization': `Bearer ${API_TOKEN}`
           },
           body: JSON.stringify({
             files: [
               "https://example.com/path/to/file"
             ]
           })
         }
       );
       
       const result = await response.json();
       return new Response(JSON.stringify(result), {
         headers: { "Content-Type": "application/json" }
       });
     } catch (e) {
       return new Response(JSON.stringify({ error: e.message }), {
         status: 500,
         headers: { "Content-Type": "application/json" }
       });
     }
   }
   ```

2. **Cache-Control Headers**:
   ```javascript
   // Add to your Worker
   const response = new Response(content, {
     headers: {
       "Cache-Control": "public, max-age=60, s-maxage=60"
     }
   });
   ```

### [CORS Issues](#cors-issues)

**Challenge**: API requests fail due to CORS restrictions

**Solution**: Configure CORS in Workers

```javascript
// functions/api/data.js
export async function onRequest(context) {
  // Fetch data from an API
  const data = { message: "This is the API response" };
  
  // Create response with CORS headers
  return new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}
```

### [Large File Uploads](#large-uploads)

**Challenge**: Uploading large files to R2 through Workers

**Solution**: Use Direct Creator Uploads

```javascript
// functions/get-upload-url.js
export async function onRequest(context) {
  const { env, request } = context;
  
  // Get filename from query
  const url = new URL(request.url);
  const filename = url.searchParams.get('filename');
  
  if (!filename) {
    return new Response("Filename required", { status: 400 });
  }
  
  // Generate presigned URL
  const uploadUrl = await env.MY_BUCKET.createUploadUrl(filename, {
    expirationSeconds: 3600, // 1 hour
  });
  
  return new Response(JSON.stringify({ uploadUrl }), {
    headers: { "Content-Type": "application/json" }
  });
}
```

Client-side usage:

```javascript
// Get upload URL
const response = await fetch('/get-upload-url?filename=large-file.zip');
const { uploadUrl } = await response.json();

// Upload directly to R2
const formData = new FormData();
formData.append('file', fileInput.files[0]);

await fetch(uploadUrl, {
  method: 'POST',
  body: formData
});
```

## [Best Practices](#best-practices)

### [Project Structure](#project-structure)

Organize your Pages project for maintainability:

```
my-pages-project/
├── public/               # Static assets
├── src/                  # Application source
├── functions/            # Worker functions
│   ├── api/              # API endpoints
│   └── _middleware.js    # Shared middleware
├── _routes.json          # Routing configuration
└── package.json
```

### [Security Best Practices](#security-practices)

1. **HTTP Security Headers**:
   ```javascript
   // functions/_middleware.js
   export async function onRequest(context) {
     const response = await context.next();
     
     // Clone the response to add security headers
     const newResponse = new Response(response.body, response);
     
     // Add security headers
     newResponse.headers.set("Content-Security-Policy", "default-src 'self'");
     newResponse.headers.set("X-Content-Type-Options", "nosniff");
     newResponse.headers.set("X-Frame-Options", "DENY");
     newResponse.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
     newResponse.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
     
     return newResponse;
   }
   ```

2. **Environment Variable Handling**:
   - Never expose sensitive environment variables to the client
   - Use Workers to proxy sensitive API requests

3. **API Authentication**:
   - Use Cloudflare Access for secure authentication
   - Implement JWT validation in Workers

### [Performance Best Practices](#performance-practices)

1. **Implement Incremental Static Regeneration**:
   ```javascript
   // functions/blog/[slug].js
   export async function onRequest(context) {
     const { request, env, params } = context;
     const slug = params.slug;
     
     // Check cache first
     const cacheKey = new URL(request.url);
     const cache = caches.default;
     let response = await cache.match(cacheKey);
     
     if (response) {
       return response;
     }
     
     // Fetch blog content
     const content = await fetchBlogContent(slug);
     
     // Create response
     response = new Response(content, {
       headers: {
         "Content-Type": "text/html",
         "Cache-Control": "public, max-age=3600"
       }
     });
     
     // Store in cache
     await cache.put(cacheKey, response.clone());
     
     return response;
   }
   ```

2. **Optimize Assets**:
   - Use Cloudflare Image Resizing
   - Implement responsive images
   - Enable Brotli compression

3. **Use Edge Config for Global Settings**:
   - Store global configuration in KV
   - Avoid redundant API calls

## [Monitoring and Analytics](#monitoring)

### [Web Analytics Integration](#web-analytics)

Cloudflare Web Analytics provides privacy-focused insights without cookies:

1. Navigate to Analytics & Logs > Web Analytics
2. Create a site
3. Add the tracking code:

```html
<!-- In your site's <head> -->
<script defer src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "your-token"}'></script>
```

### [Custom Application Monitoring](#custom-monitoring)

Implement custom monitoring with Workers:

```javascript
// functions/_middleware.js
export async function onRequest(context) {
  const start = Date.now();
  
  // Measure response time
  const response = await context.next();
  const duration = Date.now() - start;
  
  // Log to KV for analytics
  await context.env.ANALYTICS_KV.put(`request_${Date.now()}`, JSON.stringify({
    path: new URL(context.request.url).pathname,
    duration,
    status: response.status,
    timestamp: new Date().toISOString()
  }));
  
  return response;
}
```

## [Conclusion and Next Steps](#conclusion)

Cloudflare Pages offers a powerful platform for deploying static sites and JAMstack applications with advanced capabilities:

1. **Global CDN** for lightning-fast content delivery
2. **Git Integration** for seamless deployments
3. **Workers, KV, and R2** for dynamic functionality
4. **Terraform Integration** for infrastructure as code

To get started with your next Cloudflare Pages project:

1. **Plan Your Architecture**: Consider static versus dynamic components
2. **Select a Framework**: Choose the right framework for your needs
3. **Set Up Git Integration**: Connect your repository
4. **Configure Advanced Features**: Add Workers, KV, or R2 as needed
5. **Implement Best Practices**: Follow security and performance guidelines

By leveraging Cloudflare's global network and advanced features, you can build high-performance, secure, and scalable web applications that provide exceptional user experiences worldwide.

## [Further Reading](#further-reading)

- [Official Cloudflare Pages Documentation](https://developers.cloudflare.com/pages/)
- [Workers Documentation](https://developers.cloudflare.com/workers/)
- [KV Storage Guide](https://developers.cloudflare.com/workers/learning/how-kv-works/)
- [R2 Storage Documentation](https://developers.cloudflare.com/r2/)
- [Terraform Provider for Cloudflare](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs)
- [JAMstack Architecture Best Practices](/jamstack-architecture-best-practices/)