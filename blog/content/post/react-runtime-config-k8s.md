---
title: "Runtime Environment Variables with React, Kubernetes, and Apache"
date: 2025-06-05T00:00:00-05:00
draft: false
tags: ["react", "kubernetes", "apache", "docker", "environment-variables", "configmap", "twelve-factor-app"]
categories:
- DevOps
- React
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to configure environment variables in a React app at runtime using Apache and Kubernetes, following Twelve-Factor principles for portable and reusable Docker images."
more_link: "yes"
url: "/react-runtime-config-k8s/"
---

Building React apps once and deploying them across multiple environments—without rebuilding—is a common challenge. Most frontend apps hardcode environment variables at build time, meaning any change (like an API URL or login redirect) requires a full rebuild and redeploy. That’s slow, error-prone, and breaks the Twelve-Factor App principle of separating config from code.

In this guide, I’ll show you how to configure React environment variables **at runtime** using Apache and Kubernetes, enabling you to use the same Docker image across `dev`, `staging`, and `production`.

<!--more-->

# [React Runtime Configuration with Kubernetes and Apache](#react-runtime-configuration-with-kubernetes-and-apache)

## [The Twelve-Factor App: Config Principle](#the-twelve-factor-app-config-principle)

The [Twelve-Factor App](https://12factor.net/config) methodology emphasizes separating config from code. Your application shouldn’t contain hardcoded URLs, credentials, or environment flags. Instead, it should **read its config at runtime**—from environment variables, mounted files, or external services.

In Kubernetes, this usually means using **ConfigMaps or Secrets**, injected into the container at runtime. The frontend world (especially React) hasn’t caught up yet—but here’s how we make it work.

---

## [Step 1: Create a Runtime Config File with ConfigMap](#step-1-create-a-runtime-config-file-with-configmap)

Strip all `.env` files from your React app. Instead, create a ConfigMap that injects a `config.js` file containing your runtime variables:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: my-application-config
  namespace: my-namespace
data:
  config.js: |
    window.REACT_APP_API_URL="https://api.my-app.com";
    window.REACT_APP_LOGIN_URL="https://my-app.com/login";
    window.REACT_APP_REDIRECT_URL="https://my-app.com/redirect";
```

This file is a plain JS script that sets variables on the `window` object.

---

## [Step 2: Inject Config into React’s Public HTML](#step-2-inject-config-into-reacts-public-html)

In your `public/index.html`, inject the config file using a `<script>` tag:

```html
<script src="%PUBLIC_URL%/config.js"></script>
```

This loads your variables before React runs. Now let’s make sure the app reads them safely.

---

## [Step 3: Abstract Config Access in React](#step-3-abstract-config-access-in-react)

In `src/config.ts`, map and export your runtime variables:

```ts
const REACT_APP_API_URL: string = window.REACT_APP_API_URL || '';
const REACT_APP_LOGIN_URL: string = window.REACT_APP_LOGIN_URL || '';
const REACT_APP_REDIRECT_URL: string = window.REACT_APP_REDIRECT_URL || '';

export {
  REACT_APP_API_URL,
  REACT_APP_LOGIN_URL,
  REACT_APP_REDIRECT_URL
};
```

Use these throughout your app like this:

```ts
import { REACT_APP_LOGIN_URL } from 'config';

<A href={REACT_APP_LOGIN_URL}>
  Login
</A>
```

This keeps your code clean and avoids scattered `window` references.

---

## [Step 4: Dockerfile with Apache Runtime](#step-4-dockerfile-with-apache-runtime)

Here’s a multi-stage Dockerfile that builds your React app and serves it via Apache:

```dockerfile
# Build stage
FROM node:18-alpine as builder
WORKDIR /app
COPY package.json ./
RUN npm install --silent
COPY . ./
RUN npm run build

# Runtime stage
FROM httpd:2.4-alpine
COPY --from=builder /app/build /usr/local/apache2/htdocs/my-app
EXPOSE 80
ENTRYPOINT ["httpd-foreground"]
```

You do **not** bundle `config.js` here—it will be mounted at runtime via Kubernetes.

---

## [Step 5: Kubernetes Deployment with ConfigMap Mount](#step-5-kubernetes-deployment-with-configmap-mount)

Here’s how you mount the `config.js` file in your deployment:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: my-namespace
spec:
  replicas: 1
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
        - name: my-app
          image: my-app:latest
          ports:
            - containerPort: 80
          volumeMounts:
            - name: config-js
              mountPath: /usr/local/apache2/htdocs/my-app/config.js
              subPath: config.js
      volumes:
        - name: config-js
          configMap:
            name: my-application-config
```

This replaces `config.js` inside the Apache root with the runtime file.

---

## [Bonus: Local Development Tip](#bonus-local-development-tip)

If you're working locally, you can add a `public/config.js` file with the same variables:

```js
window.REACT_APP_API_URL="http://localhost:4000/api";
```

Just be sure to **add it to `.dockerignore` and `.gitignore`** so it doesn’t get bundled or committed.

---

## [Final Thoughts](#final-thoughts)

Using runtime config for React apps lets you **build once, run anywhere**. It follows cloud-native and Twelve-Factor principles, simplifies deployments, and decouples infrastructure from application logic.

Whether you're using Apache, NGINX, or another static file server, mounting a `config.js` file via Kubernetes ConfigMap is the cleanest and most scalable solution.

Stop rebuilding. Start injecting.
