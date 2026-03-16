---
title: "React Enterprise Deployment: Micro-Frontends with Kubernetes"
date: 2026-11-02T00:00:00-05:00
draft: false
tags: ["React", "Micro-Frontends", "Kubernetes", "DevOps", "Frontend", "Module Federation", "CI/CD", "Performance"]
categories:
- Frontend Development
- Kubernetes
- Architecture
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to deploying React micro-frontends on Kubernetes, covering module federation, state management, CI/CD pipelines, and performance optimization for enterprise-scale applications"
more_link: "yes"
url: "/react-enterprise-deployment-micro-frontends-kubernetes/"
keywords:
- React micro-frontends
- Module federation
- Kubernetes frontend deployment
- Frontend microservices
- Webpack 5 module federation
- React state management
- Frontend CI/CD
- Enterprise React architecture
---

In the modern enterprise landscape, frontend applications have grown exponentially in complexity and scale. Traditional monolithic frontend architectures struggle to meet the demands of large development teams, independent deployments, and technology diversity. This comprehensive guide explores how to implement and deploy React micro-frontends on Kubernetes, providing production-ready patterns for enterprise environments.

<!--more-->

# React Enterprise Deployment: Micro-Frontends with Kubernetes

## Understanding Micro-Frontend Architecture

Micro-frontends represent the extension of microservice principles to frontend development. Just as backend services can be decomposed into independently deployable units, frontend applications can be divided into smaller, self-contained pieces that work together to form a cohesive user experience.

### Key Benefits of Micro-Frontends

1. **Team Autonomy**: Different teams can work on different parts of the application independently
2. **Technology Flexibility**: Teams can choose different frameworks or versions for their micro-frontends
3. **Independent Deployments**: Deploy individual features without affecting the entire application
4. **Scalability**: Scale specific parts of the application based on demand
5. **Fault Isolation**: Issues in one micro-frontend don't necessarily break the entire application

### Architecture Patterns

There are several patterns for implementing micro-frontends:

```
┌─────────────────────────────────────────────────────────────┐
│                    Shell Application                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │   Header    │  │ Navigation  │  │   Footer    │         │
│  │   (MFE-1)   │  │   (MFE-2)   │  │   (MFE-3)   │         │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
│                                                             │
│  ┌─────────────────────────────────────────────────┐       │
│  │                 Main Content Area                │       │
│  │  ┌──────────────┐    ┌──────────────┐          │       │
│  │  │  Product     │    │   Cart       │          │       │
│  │  │  Catalog     │    │   (MFE-5)    │          │       │
│  │  │  (MFE-4)     │    └──────────────┘          │       │
│  │  └──────────────┘                               │       │
│  └─────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────┘
```

## Module Federation Implementation

Webpack 5's Module Federation is the most powerful approach for implementing micro-frontends in React applications. It allows JavaScript applications to dynamically load code from other applications at runtime.

### Setting Up Module Federation

First, let's configure the host application (shell):

```javascript
// webpack.config.js - Host Application
const HtmlWebpackPlugin = require('html-webpack-plugin');
const ModuleFederationPlugin = require('webpack/lib/container/ModuleFederationPlugin');
const deps = require('./package.json').dependencies;

module.exports = {
  mode: 'production',
  entry: './src/index.js',
  output: {
    publicPath: 'auto',
    clean: true,
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.jsx', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.(js|jsx|tsx|ts)$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: [
              '@babel/preset-react',
              '@babel/preset-typescript',
            ],
          },
        },
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader'],
      },
    ],
  },
  plugins: [
    new ModuleFederationPlugin({
      name: 'shell',
      filename: 'remoteEntry.js',
      remotes: {
        header: 'header@http://header.example.com/remoteEntry.js',
        navigation: 'navigation@http://navigation.example.com/remoteEntry.js',
        productCatalog: 'productCatalog@http://catalog.example.com/remoteEntry.js',
        cart: 'cart@http://cart.example.com/remoteEntry.js',
      },
      shared: {
        ...deps,
        react: {
          singleton: true,
          requiredVersion: deps.react,
        },
        'react-dom': {
          singleton: true,
          requiredVersion: deps['react-dom'],
        },
      },
    }),
    new HtmlWebpackPlugin({
      template: './public/index.html',
    }),
  ],
};
```

Now, configure a remote micro-frontend:

```javascript
// webpack.config.js - Product Catalog Micro-Frontend
const HtmlWebpackPlugin = require('html-webpack-plugin');
const ModuleFederationPlugin = require('webpack/lib/container/ModuleFederationPlugin');
const deps = require('./package.json').dependencies;

module.exports = {
  mode: 'production',
  entry: './src/index.js',
  output: {
    publicPath: 'auto',
    clean: true,
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.jsx', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.(js|jsx|tsx|ts)$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: [
              '@babel/preset-react',
              '@babel/preset-typescript',
            ],
          },
        },
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader', 'postcss-loader'],
      },
    ],
  },
  plugins: [
    new ModuleFederationPlugin({
      name: 'productCatalog',
      filename: 'remoteEntry.js',
      exposes: {
        './ProductList': './src/components/ProductList',
        './ProductDetail': './src/components/ProductDetail',
        './SearchBar': './src/components/SearchBar',
      },
      shared: {
        ...deps,
        react: {
          singleton: true,
          requiredVersion: deps.react,
        },
        'react-dom': {
          singleton: true,
          requiredVersion: deps['react-dom'],
        },
      },
    }),
    new HtmlWebpackPlugin({
      template: './public/index.html',
    }),
  ],
};
```

### Dynamic Import with Error Boundaries

Implement robust loading of remote modules with error handling:

```typescript
// src/utils/loadComponent.tsx
import React, { lazy, Suspense, ComponentType } from 'react';
import { ErrorBoundary } from 'react-error-boundary';

interface LoadComponentProps {
  scope: string;
  module: string;
  fallback?: React.ReactNode;
  errorFallback?: ComponentType<{ error: Error }>;
}

function loadComponent({ scope, module }: { scope: string; module: string }) {
  return async () => {
    // Initialize the share scope
    await __webpack_init_sharing__('default');
    
    const container = window[scope];
    
    // Initialize the container
    await container.init(__webpack_share_scopes__.default);
    
    // Get the module factory
    const factory = await container.get(module);
    const Module = factory();
    
    return Module;
  };
}

export function RemoteComponent({
  scope,
  module,
  fallback = <div>Loading...</div>,
  errorFallback = ({ error }) => <div>Error loading component: {error.message}</div>,
  ...props
}: LoadComponentProps & Record<string, any>) {
  const Component = lazy(loadComponent({ scope, module }));
  
  return (
    <ErrorBoundary FallbackComponent={errorFallback}>
      <Suspense fallback={fallback}>
        <Component {...props} />
      </Suspense>
    </ErrorBoundary>
  );
}

// Usage in shell application
function App() {
  return (
    <div className="app-container">
      <RemoteComponent 
        scope="header" 
        module="./Header"
        fallback={<HeaderSkeleton />}
      />
      <main>
        <RemoteComponent 
          scope="productCatalog" 
          module="./ProductList"
          fallback={<ProductListSkeleton />}
        />
      </main>
    </div>
  );
}
```

## Kubernetes Deployment Strategies

Deploying micro-frontends to Kubernetes requires careful consideration of networking, storage, and scaling strategies.

### Kubernetes Architecture for Micro-Frontends

```yaml
# namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: micro-frontends
  labels:
    name: micro-frontends
    environment: production
```

### Deployment Configuration for Shell Application

```yaml
# shell-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: shell-app
  namespace: micro-frontends
  labels:
    app: shell
    tier: frontend
spec:
  replicas: 3
  selector:
    matchLabels:
      app: shell
  template:
    metadata:
      labels:
        app: shell
        tier: frontend
    spec:
      containers:
      - name: shell
        image: myregistry/shell-app:v1.0.0
        ports:
        - containerPort: 80
          name: http
        env:
        - name: REACT_APP_HEADER_URL
          value: "http://header-service.micro-frontends.svc.cluster.local"
        - name: REACT_APP_CATALOG_URL
          value: "http://catalog-service.micro-frontends.svc.cluster.local"
        resources:
          requests:
            memory: "128Mi"
            cpu: "100m"
          limits:
            memory: "256Mi"
            cpu: "200m"
        livenessProbe:
          httpGet:
            path: /health
            port: 80
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /ready
            port: 80
          initialDelaySeconds: 5
          periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata:
  name: shell-service
  namespace: micro-frontends
spec:
  selector:
    app: shell
  ports:
  - port: 80
    targetPort: 80
    protocol: TCP
  type: ClusterIP
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: shell-hpa
  namespace: micro-frontends
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: shell-app
  minReplicas: 3
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80
```

### Micro-Frontend Deployment Template

Create a Helm chart for standardized micro-frontend deployments:

```yaml
# helm/micro-frontend/templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "micro-frontend.fullname" . }}
  namespace: {{ .Values.namespace }}
  labels:
    {{- include "micro-frontend.labels" . | nindent 4 }}
spec:
  replicas: {{ .Values.replicaCount }}
  selector:
    matchLabels:
      {{- include "micro-frontend.selectorLabels" . | nindent 6 }}
  template:
    metadata:
      annotations:
        checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
      labels:
        {{- include "micro-frontend.selectorLabels" . | nindent 8 }}
    spec:
      serviceAccountName: {{ include "micro-frontend.serviceAccountName" . }}
      containers:
      - name: {{ .Chart.Name }}
        image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
        imagePullPolicy: {{ .Values.image.pullPolicy }}
        ports:
        - name: http
          containerPort: {{ .Values.service.targetPort }}
          protocol: TCP
        env:
        {{- range $key, $value := .Values.env }}
        - name: {{ $key }}
          value: {{ $value | quote }}
        {{- end }}
        volumeMounts:
        - name: nginx-config
          mountPath: /etc/nginx/conf.d
        resources:
          {{- toYaml .Values.resources | nindent 10 }}
        livenessProbe:
          httpGet:
            path: {{ .Values.healthCheck.liveness.path }}
            port: http
          initialDelaySeconds: {{ .Values.healthCheck.liveness.initialDelaySeconds }}
          periodSeconds: {{ .Values.healthCheck.liveness.periodSeconds }}
        readinessProbe:
          httpGet:
            path: {{ .Values.healthCheck.readiness.path }}
            port: http
          initialDelaySeconds: {{ .Values.healthCheck.readiness.initialDelaySeconds }}
          periodSeconds: {{ .Values.healthCheck.readiness.periodSeconds }}
      volumes:
      - name: nginx-config
        configMap:
          name: {{ include "micro-frontend.fullname" . }}-nginx
```

### Nginx Configuration for Micro-Frontends

```nginx
# configmap-nginx.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ include "micro-frontend.fullname" . }}-nginx
  namespace: {{ .Values.namespace }}
data:
  default.conf: |
    server {
        listen 80;
        server_name _;
        root /usr/share/nginx/html;
        index index.html;
        
        # Enable gzip compression
        gzip on;
        gzip_vary on;
        gzip_min_length 1024;
        gzip_types text/plain text/css text/xml text/javascript application/javascript application/xml+rss application/json;
        
        # Security headers
        add_header X-Frame-Options "SAMEORIGIN" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header X-XSS-Protection "1; mode=block" always;
        add_header Referrer-Policy "no-referrer-when-downgrade" always;
        add_header Content-Security-Policy "default-src 'self' http: https: data: blob: 'unsafe-inline'" always;
        
        # CORS headers for module federation
        add_header Access-Control-Allow-Origin "*" always;
        add_header Access-Control-Allow-Methods "GET, POST, OPTIONS" always;
        add_header Access-Control-Allow-Headers "DNT,User-Agent,X-Requested-With,If-Modified-Since,Cache-Control,Content-Type,Range" always;
        
        # Cache static assets
        location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
            expires 1y;
            add_header Cache-Control "public, immutable";
        }
        
        # Module federation entry point
        location /remoteEntry.js {
            add_header Cache-Control "no-cache, no-store, must-revalidate";
            add_header Pragma "no-cache";
            add_header Expires "0";
        }
        
        # SPA fallback
        location / {
            try_files $uri $uri/ /index.html;
        }
        
        # Health check endpoints
        location /health {
            access_log off;
            return 200 "healthy\n";
            add_header Content-Type text/plain;
        }
        
        location /ready {
            access_log off;
            return 200 "ready\n";
            add_header Content-Type text/plain;
        }
    }
```

## State Management Across Micro-Frontends

Managing state across micro-frontends is one of the most challenging aspects of this architecture. Here are several approaches:

### 1. Event-Driven State Management

Create a custom event bus for communication between micro-frontends:

```typescript
// src/utils/eventBus.ts
type EventCallback = (data: any) => void;

class EventBus {
  private events: Map<string, Set<EventCallback>> = new Map();
  
  on(event: string, callback: EventCallback): () => void {
    if (!this.events.has(event)) {
      this.events.set(event, new Set());
    }
    
    this.events.get(event)!.add(callback);
    
    // Return unsubscribe function
    return () => {
      const callbacks = this.events.get(event);
      if (callbacks) {
        callbacks.delete(callback);
        if (callbacks.size === 0) {
          this.events.delete(event);
        }
      }
    };
  }
  
  emit(event: string, data?: any): void {
    const callbacks = this.events.get(event);
    if (callbacks) {
      callbacks.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error(`Error in event handler for ${event}:`, error);
        }
      });
    }
  }
  
  once(event: string, callback: EventCallback): void {
    const unsubscribe = this.on(event, (data) => {
      callback(data);
      unsubscribe();
    });
  }
}

// Create singleton instance
const eventBus = new EventBus();

// Make it available globally for all micro-frontends
if (typeof window !== 'undefined') {
  (window as any).__MICRO_FRONTEND_EVENT_BUS__ = eventBus;
}

export default eventBus;
```

### 2. Shared State Store

Implement a shared Redux store that can be accessed by all micro-frontends:

```typescript
// src/store/sharedStore.ts
import { configureStore, createSlice, PayloadAction } from '@reduxjs/toolkit';

// User slice that will be shared across micro-frontends
const userSlice = createSlice({
  name: 'user',
  initialState: {
    id: null as string | null,
    email: null as string | null,
    name: null as string | null,
    permissions: [] as string[],
    isAuthenticated: false,
  },
  reducers: {
    setUser: (state, action: PayloadAction<{
      id: string;
      email: string;
      name: string;
      permissions: string[];
    }>) => {
      state.id = action.payload.id;
      state.email = action.payload.email;
      state.name = action.payload.name;
      state.permissions = action.payload.permissions;
      state.isAuthenticated = true;
    },
    clearUser: (state) => {
      state.id = null;
      state.email = null;
      state.name = null;
      state.permissions = [];
      state.isAuthenticated = false;
    },
  },
});

// Cart slice shared across micro-frontends
const cartSlice = createSlice({
  name: 'cart',
  initialState: {
    items: [] as Array<{
      id: string;
      name: string;
      price: number;
      quantity: number;
    }>,
    total: 0,
  },
  reducers: {
    addItem: (state, action: PayloadAction<{
      id: string;
      name: string;
      price: number;
    }>) => {
      const existingItem = state.items.find(item => item.id === action.payload.id);
      if (existingItem) {
        existingItem.quantity += 1;
      } else {
        state.items.push({ ...action.payload, quantity: 1 });
      }
      state.total = state.items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    },
    removeItem: (state, action: PayloadAction<string>) => {
      state.items = state.items.filter(item => item.id !== action.payload);
      state.total = state.items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    },
    updateQuantity: (state, action: PayloadAction<{
      id: string;
      quantity: number;
    }>) => {
      const item = state.items.find(item => item.id === action.payload.id);
      if (item) {
        item.quantity = action.payload.quantity;
        if (item.quantity <= 0) {
          state.items = state.items.filter(i => i.id !== item.id);
        }
      }
      state.total = state.items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    },
    clearCart: (state) => {
      state.items = [];
      state.total = 0;
    },
  },
});

// Configure the shared store
const sharedStore = configureStore({
  reducer: {
    user: userSlice.reducer,
    cart: cartSlice.reducer,
  },
});

// Export actions
export const { setUser, clearUser } = userSlice.actions;
export const { addItem, removeItem, updateQuantity, clearCart } = cartSlice.actions;

// Make store available globally
if (typeof window !== 'undefined') {
  (window as any).__MICRO_FRONTEND_STORE__ = sharedStore;
}

export type RootState = ReturnType<typeof sharedStore.getState>;
export type AppDispatch = typeof sharedStore.dispatch;

export default sharedStore;
```

### 3. Custom Hook for Cross-MFE Communication

Create a React hook that simplifies communication between micro-frontends:

```typescript
// src/hooks/useMicroFrontendCommunication.ts
import { useEffect, useCallback, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import eventBus from '../utils/eventBus';
import { RootState, AppDispatch } from '../store/sharedStore';

interface UseMicroFrontendCommunicationOptions {
  scope: string;
  onMessage?: (message: any) => void;
}

export function useMicroFrontendCommunication({
  scope,
  onMessage,
}: UseMicroFrontendCommunicationOptions) {
  const dispatch = useDispatch<AppDispatch>();
  const [lastMessage, setLastMessage] = useState<any>(null);
  
  // Subscribe to events
  useEffect(() => {
    const handleMessage = (data: any) => {
      setLastMessage(data);
      onMessage?.(data);
    };
    
    const unsubscribe = eventBus.on(`${scope}:message`, handleMessage);
    
    return unsubscribe;
  }, [scope, onMessage]);
  
  // Send message to other micro-frontends
  const sendMessage = useCallback((target: string, data: any) => {
    eventBus.emit(`${target}:message`, {
      source: scope,
      timestamp: Date.now(),
      data,
    });
  }, [scope]);
  
  // Broadcast message to all micro-frontends
  const broadcast = useCallback((data: any) => {
    eventBus.emit('broadcast:message', {
      source: scope,
      timestamp: Date.now(),
      data,
    });
  }, [scope]);
  
  // Get shared state
  const getSharedState = useCallback((selector: (state: RootState) => any) => {
    const store = (window as any).__MICRO_FRONTEND_STORE__;
    if (store) {
      return selector(store.getState());
    }
    return null;
  }, []);
  
  // Update shared state
  const updateSharedState = useCallback((action: any) => {
    const store = (window as any).__MICRO_FRONTEND_STORE__;
    if (store) {
      store.dispatch(action);
    }
  }, []);
  
  return {
    sendMessage,
    broadcast,
    lastMessage,
    getSharedState,
    updateSharedState,
  };
}

// Usage example in a micro-frontend
function ProductCatalog() {
  const { sendMessage, getSharedState, updateSharedState } = useMicroFrontendCommunication({
    scope: 'productCatalog',
    onMessage: (message) => {
      console.log('Received message:', message);
    },
  });
  
  const handleAddToCart = (product: any) => {
    // Update shared cart state
    updateSharedState(addItem({
      id: product.id,
      name: product.name,
      price: product.price,
    }));
    
    // Notify cart micro-frontend
    sendMessage('cart', {
      type: 'ITEM_ADDED',
      product,
    });
  };
  
  // Rest of component...
}
```

## CI/CD Pipelines for Micro-Frontends

Implementing robust CI/CD pipelines is crucial for maintaining quality and consistency across multiple micro-frontends.

### GitHub Actions Workflow

```yaml
# .github/workflows/micro-frontend-ci-cd.yml
name: Micro-Frontend CI/CD

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}

jobs:
  detect-changes:
    runs-on: ubuntu-latest
    outputs:
      shell: ${{ steps.filter.outputs.shell }}
      header: ${{ steps.filter.outputs.header }}
      catalog: ${{ steps.filter.outputs.catalog }}
      cart: ${{ steps.filter.outputs.cart }}
    steps:
    - uses: actions/checkout@v3
    - uses: dorny/paths-filter@v2
      id: filter
      with:
        filters: |
          shell:
            - 'packages/shell/**'
          header:
            - 'packages/header/**'
          catalog:
            - 'packages/catalog/**'
          cart:
            - 'packages/cart/**'

  test:
    needs: detect-changes
    runs-on: ubuntu-latest
    strategy:
      matrix:
        package: [shell, header, catalog, cart]
    steps:
    - uses: actions/checkout@v3
    - name: Setup Node.js
      uses: actions/setup-node@v3
      with:
        node-version: '18'
        cache: 'npm'
    
    - name: Install dependencies
      run: |
        cd packages/${{ matrix.package }}
        npm ci
    
    - name: Run linting
      run: |
        cd packages/${{ matrix.package }}
        npm run lint
    
    - name: Run unit tests
      run: |
        cd packages/${{ matrix.package }}
        npm run test:unit -- --coverage
    
    - name: Run integration tests
      run: |
        cd packages/${{ matrix.package }}
        npm run test:integration
    
    - name: SonarCloud Scan
      uses: SonarSource/sonarcloud-github-action@master
      env:
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}
      with:
        projectBaseDir: packages/${{ matrix.package }}

  build:
    needs: [detect-changes, test]
    runs-on: ubuntu-latest
    strategy:
      matrix:
        package: [shell, header, catalog, cart]
    if: needs.detect-changes.outputs[matrix.package] == 'true'
    steps:
    - uses: actions/checkout@v3
    
    - name: Setup Node.js
      uses: actions/setup-node@v3
      with:
        node-version: '18'
        cache: 'npm'
    
    - name: Install dependencies
      run: |
        cd packages/${{ matrix.package }}
        npm ci
    
    - name: Build application
      run: |
        cd packages/${{ matrix.package }}
        npm run build
        
    - name: Run Lighthouse CI
      uses: treosh/lighthouse-ci-action@v9
      with:
        configPath: packages/${{ matrix.package }}/lighthouserc.json
        uploadArtifacts: true
    
    - name: Set up Docker Buildx
      uses: docker/setup-buildx-action@v2
    
    - name: Log in to Container Registry
      uses: docker/login-action@v2
      with:
        registry: ${{ env.REGISTRY }}
        username: ${{ github.actor }}
        password: ${{ secrets.GITHUB_TOKEN }}
    
    - name: Extract metadata
      id: meta
      uses: docker/metadata-action@v4
      with:
        images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}-${{ matrix.package }}
        tags: |
          type=ref,event=branch
          type=ref,event=pr
          type=semver,pattern={{version}}
          type=semver,pattern={{major}}.{{minor}}
          type=sha,prefix={{branch}}-
    
    - name: Build and push Docker image
      uses: docker/build-push-action@v4
      with:
        context: packages/${{ matrix.package }}
        push: true
        tags: ${{ steps.meta.outputs.tags }}
        labels: ${{ steps.meta.outputs.labels }}
        cache-from: type=gha
        cache-to: type=gha,mode=max
        build-args: |
          BUILD_DATE=${{ github.event.head_commit.timestamp }}
          VCS_REF=${{ github.sha }}
          VERSION=${{ steps.meta.outputs.version }}

  deploy-staging:
    needs: build
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/develop'
    steps:
    - uses: actions/checkout@v3
    
    - name: Setup Helm
      uses: azure/setup-helm@v3
      with:
        version: 'v3.12.0'
    
    - name: Configure kubectl
      uses: azure/setup-kubectl@v3
      with:
        version: 'v1.27.0'
    
    - name: Setup kubeconfig
      run: |
        echo "${{ secrets.KUBE_CONFIG_STAGING }}" | base64 -d > kubeconfig
        echo "KUBECONFIG=kubeconfig" >> $GITHUB_ENV
    
    - name: Deploy to staging
      run: |
        for package in shell header catalog cart; do
          if [ "${{ needs.detect-changes.outputs[package] }}" == "true" ]; then
            helm upgrade --install \
              mfe-${package} \
              ./helm/micro-frontend \
              --namespace micro-frontends-staging \
              --create-namespace \
              --set image.repository=${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}-${package} \
              --set image.tag=develop-${{ github.sha }} \
              --set ingress.host=${package}-staging.example.com \
              --wait
          fi
        done

  integration-tests:
    needs: deploy-staging
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/develop'
    steps:
    - uses: actions/checkout@v3
    
    - name: Setup Node.js
      uses: actions/setup-node@v3
      with:
        node-version: '18'
    
    - name: Install dependencies
      run: |
        cd e2e
        npm ci
    
    - name: Run E2E tests
      run: |
        cd e2e
        npm run test:e2e
      env:
        BASE_URL: https://shell-staging.example.com
        CATALOG_URL: https://catalog-staging.example.com
        CART_URL: https://cart-staging.example.com

  deploy-production:
    needs: [build, integration-tests]
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    environment: production
    steps:
    - uses: actions/checkout@v3
    
    - name: Setup Helm
      uses: azure/setup-helm@v3
      with:
        version: 'v3.12.0'
    
    - name: Configure kubectl
      uses: azure/setup-kubectl@v3
      with:
        version: 'v1.27.0'
    
    - name: Setup kubeconfig
      run: |
        echo "${{ secrets.KUBE_CONFIG_PRODUCTION }}" | base64 -d > kubeconfig
        echo "KUBECONFIG=kubeconfig" >> $GITHUB_ENV
    
    - name: Deploy to production with canary
      run: |
        for package in shell header catalog cart; do
          if [ "${{ needs.detect-changes.outputs[package] }}" == "true" ]; then
            # Deploy canary version (10% traffic)
            helm upgrade --install \
              mfe-${package}-canary \
              ./helm/micro-frontend \
              --namespace micro-frontends-production \
              --create-namespace \
              --set image.repository=${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}-${package} \
              --set image.tag=main-${{ github.sha }} \
              --set replicaCount=1 \
              --set canary.enabled=true \
              --set canary.weight=10 \
              --wait
            
            # Wait for canary validation
            sleep 300
            
            # Check canary metrics
            CANARY_SUCCESS=$(kubectl exec -n monitoring prometheus-0 -- \
              promtool query instant \
              'rate(http_requests_total{app="mfe-'${package}'-canary",status=~"2.."}[5m]) / rate(http_requests_total{app="mfe-'${package}'-canary"}[5m])' | \
              jq -r '.data.result[0].value[1]')
            
            if (( $(echo "$CANARY_SUCCESS > 0.95" | bc -l) )); then
              # Promote to full production
              helm upgrade --install \
                mfe-${package} \
                ./helm/micro-frontend \
                --namespace micro-frontends-production \
                --set image.repository=${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}-${package} \
                --set image.tag=main-${{ github.sha }} \
                --set ingress.host=${package}.example.com \
                --wait
              
              # Remove canary
              helm uninstall mfe-${package}-canary -n micro-frontends-production
            else
              echo "Canary deployment failed for ${package}. Success rate: $CANARY_SUCCESS"
              exit 1
            fi
          fi
        done
```

## Performance Optimization

Performance is critical for micro-frontend architectures. Here are comprehensive optimization strategies:

### 1. Bundle Optimization

```javascript
// webpack.production.config.js
const TerserPlugin = require('terser-webpack-plugin');
const CssMinimizerPlugin = require('css-minimizer-webpack-plugin');
const CompressionPlugin = require('compression-webpack-plugin');
const { BundleAnalyzerPlugin } = require('webpack-bundle-analyzer');

module.exports = {
  optimization: {
    minimize: true,
    minimizer: [
      new TerserPlugin({
        terserOptions: {
          parse: {
            ecma: 8,
          },
          compress: {
            ecma: 5,
            warnings: false,
            comparisons: false,
            inline: 2,
            drop_console: true,
            drop_debugger: true,
          },
          mangle: {
            safari10: true,
          },
          output: {
            ecma: 5,
            comments: false,
            ascii_only: true,
          },
        },
      }),
      new CssMinimizerPlugin(),
    ],
    splitChunks: {
      chunks: 'all',
      cacheGroups: {
        vendor: {
          test: /[\\/]node_modules[\\/]/,
          name: 'vendors',
          priority: 10,
          reuseExistingChunk: true,
        },
        common: {
          minChunks: 2,
          priority: 5,
          reuseExistingChunk: true,
        },
      },
    },
    runtimeChunk: 'single',
  },
  plugins: [
    new CompressionPlugin({
      algorithm: 'gzip',
      test: /\.(js|css|html|svg)$/,
      threshold: 8192,
      minRatio: 0.8,
    }),
    new CompressionPlugin({
      algorithm: 'brotliCompress',
      test: /\.(js|css|html|svg)$/,
      threshold: 8192,
      minRatio: 0.8,
      filename: '[path][base].br',
    }),
    process.env.ANALYZE && new BundleAnalyzerPlugin(),
  ].filter(Boolean),
};
```

### 2. Resource Hints and Preloading

```typescript
// src/utils/resourceHints.ts
export function preloadMicroFrontend(url: string): void {
  const link = document.createElement('link');
  link.rel = 'preload';
  link.as = 'script';
  link.href = url;
  document.head.appendChild(link);
}

export function prefetchMicroFrontend(url: string): void {
  const link = document.createElement('link');
  link.rel = 'prefetch';
  link.href = url;
  document.head.appendChild(link);
}

export function preconnectToMicroFrontend(origin: string): void {
  const link = document.createElement('link');
  link.rel = 'preconnect';
  link.href = origin;
  document.head.appendChild(link);
}

// Usage in shell application
useEffect(() => {
  // Preconnect to micro-frontend origins
  preconnectToMicroFrontend('https://catalog.example.com');
  preconnectToMicroFrontend('https://cart.example.com');
  
  // Prefetch micro-frontends likely to be used
  prefetchMicroFrontend('https://catalog.example.com/remoteEntry.js');
  prefetchMicroFrontend('https://cart.example.com/remoteEntry.js');
}, []);
```

### 3. Service Worker for Caching

```javascript
// src/serviceWorker.js
const CACHE_NAME = 'mfe-cache-v1';
const REMOTE_ENTRY_CACHE = 'remote-entries-v1';

// URLs to cache
const urlsToCache = [
  '/',
  '/static/css/main.css',
  '/static/js/main.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(urlsToCache))
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  
  // Special handling for remoteEntry.js files
  if (url.pathname.endsWith('remoteEntry.js')) {
    event.respondWith(
      caches.open(REMOTE_ENTRY_CACHE).then((cache) => {
        return fetch(request).then((response) => {
          // Cache the fresh response
          cache.put(request, response.clone());
          return response;
        }).catch(() => {
          // Fallback to cache if network fails
          return cache.match(request);
        });
      })
    );
    return;
  }
  
  // Network-first strategy for API calls
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(() => {
        return caches.match(request);
      })
    );
    return;
  }
  
  // Cache-first strategy for static assets
  event.respondWith(
    caches.match(request).then((response) => {
      return response || fetch(request);
    })
  );
});

// Periodic sync for updating remote entries
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'update-remote-entries') {
    event.waitUntil(updateRemoteEntries());
  }
});

async function updateRemoteEntries() {
  const cache = await caches.open(REMOTE_ENTRY_CACHE);
  const requests = await cache.keys();
  
  const updatePromises = requests.map(async (request) => {
    try {
      const response = await fetch(request);
      await cache.put(request, response);
    } catch (error) {
      console.error('Failed to update remote entry:', request.url, error);
    }
  });
  
  await Promise.all(updatePromises);
}
```

### 4. Performance Monitoring

```typescript
// src/utils/performanceMonitoring.ts
interface PerformanceMetric {
  name: string;
  value: number;
  unit: string;
  timestamp: number;
}

class PerformanceMonitor {
  private metrics: PerformanceMetric[] = [];
  private observer: PerformanceObserver | null = null;
  
  constructor() {
    this.initializeObserver();
    this.measureVitals();
  }
  
  private initializeObserver(): void {
    if ('PerformanceObserver' in window) {
      this.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.entryType === 'navigation') {
            this.recordNavigationTiming(entry as PerformanceNavigationTiming);
          } else if (entry.entryType === 'resource') {
            this.recordResourceTiming(entry as PerformanceResourceTiming);
          } else if (entry.entryType === 'measure') {
            this.recordMeasure(entry as PerformanceMeasure);
          }
        }
      });
      
      this.observer.observe({ 
        entryTypes: ['navigation', 'resource', 'measure'] 
      });
    }
  }
  
  private measureVitals(): void {
    // First Contentful Paint
    if ('PerformancePaintTiming' in window) {
      const paintEntries = performance.getEntriesByType('paint');
      const fcp = paintEntries.find(entry => entry.name === 'first-contentful-paint');
      if (fcp) {
        this.recordMetric('FCP', fcp.startTime, 'ms');
      }
    }
    
    // Largest Contentful Paint
    if ('PerformanceObserver' in window && 'LargestContentfulPaint' in window) {
      const lcpObserver = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const lastEntry = entries[entries.length - 1];
        this.recordMetric('LCP', lastEntry.startTime, 'ms');
      });
      lcpObserver.observe({ entryTypes: ['largest-contentful-paint'] });
    }
    
    // Cumulative Layout Shift
    if ('PerformanceObserver' in window && 'LayoutShift' in window) {
      let clsValue = 0;
      const clsObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!(entry as any).hadRecentInput) {
            clsValue += (entry as any).value;
          }
        }
        this.recordMetric('CLS', clsValue, 'score');
      });
      clsObserver.observe({ entryTypes: ['layout-shift'] });
    }
  }
  
  private recordNavigationTiming(entry: PerformanceNavigationTiming): void {
    this.recordMetric('DNS', entry.domainLookupEnd - entry.domainLookupStart, 'ms');
    this.recordMetric('TCP', entry.connectEnd - entry.connectStart, 'ms');
    this.recordMetric('TTFB', entry.responseStart - entry.requestStart, 'ms');
    this.recordMetric('DOM Processing', entry.domComplete - entry.responseEnd, 'ms');
    this.recordMetric('Page Load', entry.loadEventEnd - entry.navigationStart, 'ms');
  }
  
  private recordResourceTiming(entry: PerformanceResourceTiming): void {
    if (entry.name.includes('remoteEntry.js')) {
      this.recordMetric(
        `MFE Load: ${new URL(entry.name).hostname}`,
        entry.responseEnd - entry.startTime,
        'ms'
      );
    }
  }
  
  private recordMeasure(entry: PerformanceMeasure): void {
    this.recordMetric(entry.name, entry.duration, 'ms');
  }
  
  private recordMetric(name: string, value: number, unit: string): void {
    const metric: PerformanceMetric = {
      name,
      value,
      unit,
      timestamp: Date.now(),
    };
    
    this.metrics.push(metric);
    this.sendToAnalytics(metric);
  }
  
  private sendToAnalytics(metric: PerformanceMetric): void {
    // Send to your analytics service
    if ('sendBeacon' in navigator) {
      navigator.sendBeacon('/api/metrics', JSON.stringify(metric));
    }
  }
  
  public getMetrics(): PerformanceMetric[] {
    return [...this.metrics];
  }
  
  public measureMicroFrontendLoad(name: string, fn: () => Promise<void>): Promise<void> {
    const startMark = `mfe-start-${name}`;
    const endMark = `mfe-end-${name}`;
    const measureName = `MFE Load: ${name}`;
    
    performance.mark(startMark);
    
    return fn().finally(() => {
      performance.mark(endMark);
      performance.measure(measureName, startMark, endMark);
    });
  }
}

export const performanceMonitor = new PerformanceMonitor();
```

## Security Considerations

Security is paramount when implementing micro-frontends. Here are key security measures:

### 1. Content Security Policy

```typescript
// src/security/csp.ts
export function generateCSP(): string {
  const directives = {
    'default-src': ["'self'"],
    'script-src': [
      "'self'",
      "'unsafe-inline'", // Required for module federation
      'https://*.example.com', // Your micro-frontend domains
    ],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'https:'],
    'connect-src': [
      "'self'",
      'https://api.example.com',
      'https://*.example.com',
      'wss://*.example.com',
    ],
    'font-src': ["'self'"],
    'object-src': ["'none'"],
    'media-src': ["'self'"],
    'frame-src': ["'none'"],
    'form-action': ["'self'"],
    'base-uri': ["'self'"],
    'upgrade-insecure-requests': [],
  };
  
  return Object.entries(directives)
    .map(([directive, values]) => `${directive} ${values.join(' ')}`)
    .join('; ');
}

// Apply CSP in Kubernetes Ingress
```

### 2. Authentication and Authorization

```typescript
// src/auth/authProvider.tsx
import React, { createContext, useContext, useEffect, useState } from 'react';
import jwt_decode from 'jwt-decode';

interface AuthContextType {
  user: User | null;
  token: string | null;
  login: (token: string) => void;
  logout: () => void;
  hasPermission: (permission: string) => boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  
  useEffect(() => {
    // Check for existing token
    const storedToken = localStorage.getItem('auth_token');
    if (storedToken) {
      validateAndSetToken(storedToken);
    }
  }, []);
  
  const validateAndSetToken = (token: string) => {
    try {
      const decoded = jwt_decode<any>(token);
      
      // Check expiration
      if (decoded.exp * 1000 < Date.now()) {
        logout();
        return;
      }
      
      setToken(token);
      setUser({
        id: decoded.sub,
        email: decoded.email,
        permissions: decoded.permissions || [],
      });
      
      // Share auth state across micro-frontends
      window.postMessage({
        type: 'AUTH_STATE_CHANGE',
        payload: { token, user: decoded },
      }, '*');
    } catch (error) {
      console.error('Invalid token:', error);
      logout();
    }
  };
  
  const login = (token: string) => {
    validateAndSetToken(token);
    localStorage.setItem('auth_token', token);
  };
  
  const logout = () => {
    setUser(null);
    setToken(null);
    localStorage.removeItem('auth_token');
    
    // Notify all micro-frontends
    window.postMessage({
      type: 'AUTH_LOGOUT',
    }, '*');
  };
  
  const hasPermission = (permission: string): boolean => {
    return user?.permissions.includes(permission) || false;
  };
  
  // Listen for auth changes from other micro-frontends
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      
      if (event.data.type === 'AUTH_STATE_CHANGE') {
        const { token, user } = event.data.payload;
        setToken(token);
        setUser(user);
      } else if (event.data.type === 'AUTH_LOGOUT') {
        logout();
      }
    };
    
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);
  
  return (
    <AuthContext.Provider value={{ user, token, login, logout, hasPermission }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};
```

## Monitoring and Observability

Implement comprehensive monitoring for your micro-frontend architecture:

```yaml
# prometheus-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: prometheus-config
  namespace: monitoring
data:
  prometheus.yml: |
    global:
      scrape_interval: 15s
      evaluation_interval: 15s
    
    scrape_configs:
    - job_name: 'micro-frontends'
      kubernetes_sd_configs:
      - role: pod
        namespaces:
          names:
          - micro-frontends
      relabel_configs:
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
        action: keep
        regex: true
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_path]
        action: replace
        target_label: __metrics_path__
        regex: (.+)
      - source_labels: [__address__, __meta_kubernetes_pod_annotation_prometheus_io_port]
        action: replace
        regex: ([^:]+)(?::\d+)?;(\d+)
        replacement: $1:$2
        target_label: __address__
      - action: labelmap
        regex: __meta_kubernetes_pod_label_(.+)
```

## Conclusion

Deploying React micro-frontends on Kubernetes provides a scalable, maintainable architecture for enterprise applications. Key takeaways include:

1. **Module Federation** enables true runtime integration of micro-frontends
2. **Kubernetes** provides the orchestration needed for complex deployments
3. **State Management** requires careful planning and implementation
4. **CI/CD Pipelines** must handle the complexity of multiple deployments
5. **Performance Optimization** is crucial for user experience
6. **Security** must be built-in from the start

By following these patterns and practices, you can build robust, scalable frontend architectures that meet enterprise requirements while maintaining developer productivity and application performance.

The micro-frontend architecture is not without its challenges, but when implemented correctly, it provides unparalleled flexibility and scalability for large-scale frontend applications. As your organization grows, this architecture will enable your teams to move faster while maintaining high quality and performance standards.