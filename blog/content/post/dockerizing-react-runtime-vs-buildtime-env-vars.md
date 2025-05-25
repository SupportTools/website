---
title: "Dockerizing React Applications: Runtime vs. Build-time Environment Variables"
date: 2026-01-20T09:00:00-05:00
draft: false
tags: ["Docker", "React", "Environment Variables", "DevOps", "CI/CD", "Frontend", "Containerization"]
categories:
- DevOps
- Frontend Development
author: "Matthew Mattox - mmattox@support.tools"
description: "A practical comparison of build-time vs. runtime environment variable injection for containerized React applications, with implementation examples and production deployment considerations"
more_link: "yes"
url: "/dockerizing-react-runtime-vs-buildtime-env-vars/"
---

When containerizing React applications for deployment across multiple environments, one of the most critical architectural decisions is how to handle environment-specific configuration. After implementing both approaches across numerous production deployments, I've developed strong opinions about the tradeoffs between injecting environment variables at build time versus runtime. This post dives into both methods with practical examples and explains which approach I recommend for most production scenarios.

<!--more-->

## The Environment Variable Challenge in React Applications

React applications, like most modern frontend frameworks, typically bundle environment variables during the build process. This presents a unique challenge when containerizing these applications:

1. **Build-time variables**: Values are embedded into the JavaScript bundle during the build process (`npm run build` or equivalent)
2. **Runtime variables**: Values need to be injected after the app is built, which requires additional techniques

This distinction becomes crucial when deploying the same application across development, staging, and production environments, especially within a containerized workflow.

## Approach 1: Build-Time Environment Variable Injection

With this approach, environment variables are injected during the Docker image build process using build arguments (`--build-arg`). These values are then permanently embedded in the JavaScript bundle.

### Implementation Example

Here's a Dockerfile that demonstrates this approach:

```dockerfile
# Build stage
FROM node:18-alpine as build

# Define build arguments
ARG REACT_APP_API_URL
ARG REACT_APP_FEATURE_FLAGS

# Set environment variables for the build process
ENV REACT_APP_API_URL=$REACT_APP_API_URL
ENV REACT_APP_FEATURE_FLAGS=$REACT_APP_FEATURE_FLAGS

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Production stage
FROM nginx:alpine
COPY --from=build /app/build /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

To build this image for different environments:

```bash
# For development
docker build \
  --build-arg REACT_APP_API_URL=https://dev-api.example.com \
  --build-arg REACT_APP_FEATURE_FLAGS='{"newFeature":true}' \
  -t myapp:dev .

# For production
docker build \
  --build-arg REACT_APP_API_URL=https://api.example.com \
  --build-arg REACT_APP_FEATURE_FLAGS='{"newFeature":false}' \
  -t myapp:prod .
```

Running the container is straightforward since all configuration is already baked in:

```bash
docker run -p 80:80 myapp:prod
```

### Pros of Build-Time Injection

1. **Simplicity**: No additional runtime scripts or complexity needed
2. **Immutability**: Each environment has its own immutable image, preventing configuration drift
3. **Security**: Sensitive variables aren't exposed in the container environment
4. **Performance**: No runtime processing overhead
5. **Validation**: Configuration issues are caught during build, not at runtime

### Cons of Build-Time Injection

1. **Image Proliferation**: Requires building and storing separate images for each environment
2. **CI/CD Complexity**: Pipeline needs to build multiple versions of the same application
3. **Flexibility Limitations**: Configuration changes require rebuilding and redeploying

## Approach 2: Runtime Environment Variable Injection

This approach involves building a single Docker image and injecting environment variables when the container starts. Since React applications bundle environment variables at build time, this requires an additional runtime script to modify the JavaScript files.

### Implementation Example

First, we need a script to replace placeholders in the bundled JavaScript files at container startup:

```bash
#!/bin/sh
# env.sh - Script to replace placeholders with environment variables

# Process .js files
echo "Replacing environment variables in JS files..."
for file in /usr/share/nginx/html/static/js/*.js; do
  # Replace PLACEHOLDER_API_URL with actual environment variable
  if [ ! -z "$REACT_APP_API_URL" ]; then
    sed -i "s|PLACEHOLDER_API_URL|$REACT_APP_API_URL|g" $file
  fi
  
  # Replace PLACEHOLDER_FEATURE_FLAGS with actual environment variable
  if [ ! -z "$REACT_APP_FEATURE_FLAGS" ]; then
    # Escape special characters in JSON
    ESCAPED_FLAGS=$(echo $REACT_APP_FEATURE_FLAGS | sed 's/\//\\\//g')
    sed -i "s|PLACEHOLDER_FEATURE_FLAGS|$ESCAPED_FLAGS|g" $file
  fi
done

echo "Environment variable replacement complete"

# Start nginx
exec "$@"
```

Then, our Dockerfile needs to include this script and use it as an entrypoint:

```dockerfile
# Build stage
FROM node:18-alpine as build

# Define placeholder values for the build
ENV REACT_APP_API_URL=PLACEHOLDER_API_URL
ENV REACT_APP_FEATURE_FLAGS=PLACEHOLDER_FEATURE_FLAGS

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Production stage
FROM nginx:alpine
COPY --from=build /app/build /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY env.sh /docker-entrypoint.d/40-env.sh
RUN chmod +x /docker-entrypoint.d/40-env.sh
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

Notice that we're using special placeholder values (`PLACEHOLDER_API_URL`) during build. The runtime script will replace these values with actual environment variables when the container starts.

To build the image:

```bash
docker build -t myapp:latest .
```

And to run it with different environments:

```bash
# For development
docker run -p 80:80 \
  -e REACT_APP_API_URL=https://dev-api.example.com \
  -e REACT_APP_FEATURE_FLAGS='{"newFeature":true}' \
  myapp:latest

# For production
docker run -p 80:80 \
  -e REACT_APP_API_URL=https://api.example.com \
  -e REACT_APP_FEATURE_FLAGS='{"newFeature":false}' \
  myapp:latest
```

### Pros of Runtime Injection

1. **Single Image**: Build once, deploy anywhere with different environment variables
2. **Flexible Configuration**: Change variables without rebuilding the image
3. **Simplified CI/CD**: Only need to build and test one image
4. **Dynamic Updates**: Environment variables can be changed without redeployment

### Cons of Runtime Injection

1. **Complexity**: Requires additional scripts and understanding of how to modify built files
2. **Performance Impact**: Small startup delay due to file processing
3. **Limited to String Replacements**: Complex data structures might be challenging to replace correctly
4. **Error Prone**: Runtime errors if replacements fail or variables are missing

## Which Approach Should You Choose?

After implementing both approaches across various React applications, I've developed a framework for deciding which method to use:

### Choose Build-Time Injection When:

1. **Security is paramount**: For applications with sensitive configuration (like authentication endpoints)
2. **Environment count is small**: If you only have 2-3 stable environments
3. **Configuration rarely changes**: For stable applications with infrequent config updates
4. **Validation is critical**: When you want to ensure all environment variables are present at build time

### Choose Runtime Injection When:

1. **Environments proliferate**: When you have many environments or dynamic environment creation
2. **Configuration changes frequently**: For applications under active development
3. **CI/CD pipeline optimization is important**: To reduce build times and artifacts
4. **Dynamic deployment is needed**: For multi-tenant applications or customizable deployments

## Real-World Implementation: A Hybrid Approach

In production applications, I often implement a hybrid approach that provides the best of both worlds:

```dockerfile
# Build stage
FROM node:18-alpine as build

# Build arguments for base configuration that rarely changes
ARG REACT_APP_VERSION
ARG REACT_APP_BUILD_DATE

# Environment variables that should be replaceable at runtime
ENV REACT_APP_VERSION=$REACT_APP_VERSION
ENV REACT_APP_BUILD_DATE=$REACT_APP_BUILD_DATE
ENV REACT_APP_API_URL=PLACEHOLDER_API_URL
ENV REACT_APP_AUTH_DOMAIN=PLACEHOLDER_AUTH_DOMAIN

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Production stage
FROM nginx:alpine
COPY --from=build /app/build /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY env.sh /docker-entrypoint.d/40-env.sh
RUN chmod +x /docker-entrypoint.d/40-env.sh

# Health check
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -q --spider http://localhost/ || exit 1

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

This approach:

1. Bakes in build-specific information at build time (version, build date)
2. Uses placeholder values for environment-specific configuration
3. Replaces placeholders at runtime with actual environment variables

The environment replacement script is enhanced to provide better error handling:

```bash
#!/bin/sh
# env.sh - Script to replace placeholders with environment variables

# Required environment variables
REQUIRED_VARS="REACT_APP_API_URL REACT_APP_AUTH_DOMAIN"

# Check for required variables
for var in $REQUIRED_VARS; do
  if [ -z "$(eval echo \$$var)" ]; then
    echo "Error: Required environment variable $var is not set!"
    exit 1
  fi
done

# Process .js files
echo "Replacing environment variables in JS files..."
find /usr/share/nginx/html -type f -name "*.js" | while read file; do
  # Replace each placeholder with its environment variable
  sed -i "s|PLACEHOLDER_API_URL|$REACT_APP_API_URL|g" $file
  sed -i "s|PLACEHOLDER_AUTH_DOMAIN|$REACT_APP_AUTH_DOMAIN|g" $file
done

echo "Environment variable replacement complete"

# Execute the original command
exec "$@"
```

## Optimizing for Kubernetes Deployments

When deploying React applications in Kubernetes, the runtime injection approach offers additional advantages:

1. **ConfigMaps and Secrets**: Environment variables can be managed through Kubernetes resources
2. **Rolling Updates**: Configuration changes can be applied without rebuilding images
3. **Resource Efficiency**: Fewer images to store and manage

Here's an example Kubernetes deployment using runtime configuration:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: react-app
spec:
  replicas: 3
  selector:
    matchLabels:
      app: react-app
  template:
    metadata:
      labels:
        app: react-app
    spec:
      containers:
      - name: react-app
        image: myapp:latest
        ports:
        - containerPort: 80
        env:
        - name: REACT_APP_API_URL
          valueFrom:
            configMapKeyRef:
              name: react-app-config
              key: api_url
        - name: REACT_APP_AUTH_DOMAIN
          valueFrom:
            configMapKeyRef:
              name: react-app-config
              key: auth_domain
        resources:
          requests:
            memory: "64Mi"
            cpu: "100m"
          limits:
            memory: "128Mi"
            cpu: "200m"
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: react-app-config
data:
  api_url: "https://api.example.com"
  auth_domain: "auth.example.com"
```

## Performance Considerations

There's a common concern about the performance impact of runtime environment variable injection. In practice, I've found this impact to be negligible for most applications:

1. **Container Startup**: The script adds ~100-200ms to container startup time
2. **File Processing**: Modern servers can process the file replacements very quickly
3. **Caching**: Once the files are processed, they're served from the filesystem as normal

In Kubernetes environments where pod startup might already take several seconds, this small additional delay is rarely noticeable.

## Monitoring and Debugging

With runtime injection, it's important to add proper monitoring:

1. **Container Logs**: The replacement script should log its activity
2. **Health Checks**: Add a healthcheck that verifies critical configuration
3. **Version Information**: Include a `/version` or health endpoint that displays current configuration (without sensitive values)

## Conclusion: My Recommended Approach

After working with both methods across multiple production applications, I generally recommend the **runtime injection approach** for most React applications deployed in container environments, especially those using Kubernetes or other orchestration platforms.

The benefits of flexibility, CI/CD simplicity, and operational efficiency typically outweigh the small additional complexity. The hybrid approach I've outlined provides a good balance by baking in truly static configuration at build time while allowing environment-specific values to be injected at runtime.

That said, for applications with extremely sensitive configuration or those with only a couple of stable environments, the build-time approach remains a valid and sometimes preferable option.

Whichever method you choose, documenting your approach and ensuring all team members understand how configuration flows through your application is essential for maintaining a stable and secure deployment process.

Have you implemented either of these approaches in your React applications? I'd be interested to hear about your experiences in the comments below.