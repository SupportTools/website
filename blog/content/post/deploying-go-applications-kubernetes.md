---
title: "Deploying Go Microservices on Kubernetes: A Hands-On Guide"
date: 2025-12-30T09:00:00-05:00
draft: false
tags: ["golang", "kubernetes", "microservices", "devops", "containers", "cloud-native"]
categories: ["Development", "Go", "Kubernetes", "DevOps"]
---

## Introduction

Kubernetes has become the de facto standard for orchestrating containerized applications in production environments. Its powerful features for scaling, self-healing, and declarative configuration make it an excellent platform for deploying Go microservices. In this hands-on guide, we'll walk through the complete process of deploying a set of Go microservices on Kubernetes, from containerization to production deployment.

Go is particularly well-suited for containerized environments due to its small binary sizes, minimal dependencies, and excellent performance characteristics. We'll leverage these strengths while exploring Kubernetes features that help build resilient, scalable applications.

## Prerequisites

Before getting started, ensure you have:

1. A basic understanding of Go programming
2. Docker installed locally
3. kubectl configured to connect to a Kubernetes cluster
4. A code editor of your choice
5. Basic familiarity with YAML

If you don't have a Kubernetes cluster yet, you can set up a local one using Minikube, Kind, or Docker Desktop.

## Our Example Application

For this guide, we'll build and deploy a simple e-commerce microservices application consisting of:

1. **Product Service**: Manages product information and inventory
2. **User Service**: Handles user authentication and profile management
3. **Order Service**: Processes customer orders
4. **Frontend**: A simple web interface for the application

Each service will be written in Go, containerized, and deployed to Kubernetes.

## Part 1: Building Containerized Go Microservices

### Product Service

Let's start by building a simple product service. Create a new directory called `product-service` and add the following files:

```go
// main.go
package main

import (
    "encoding/json"
    "log"
    "net/http"
    "os"
    "strconv"
    "sync"
)

type Product struct {
    ID          string  `json:"id"`
    Name        string  `json:"name"`
    Description string  `json:"description"`
    Price       float64 `json:"price"`
    Stock       int     `json:"stock"`
}

var (
    products = []Product{
        {ID: "1", Name: "Go Gopher Plush Toy", Description: "Cute Gopher plush toy", Price: 19.99, Stock: 100},
        {ID: "2", Name: "Kubernetes Cookbook", Description: "Guide to K8s deployment", Price: 39.99, Stock: 50},
        {ID: "3", Name: "Mechanical Keyboard", Description: "Programmer's keyboard", Price: 129.99, Stock: 30},
    }
    mu sync.RWMutex
)

func getProducts(w http.ResponseWriter, r *http.Request) {
    mu.RLock()
    defer mu.RUnlock()
    
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(products)
}

func getProduct(w http.ResponseWriter, r *http.Request) {
    id := r.URL.Path[len("/products/"):]
    
    mu.RLock()
    defer mu.RUnlock()
    
    for _, product := range products {
        if product.ID == id {
            w.Header().Set("Content-Type", "application/json")
            json.NewEncoder(w).Encode(product)
            return
        }
    }
    
    w.WriteHeader(http.StatusNotFound)
    w.Write([]byte(`{"error": "Product not found"}`))
}

func health(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusOK)
    w.Write([]byte(`{"status": "ok"}`))
}

func main() {
    port := os.Getenv("PORT")
    if port == "" {
        port = "8080"
    }
    
    http.HandleFunc("/products", getProducts)
    http.HandleFunc("/products/", getProduct)
    http.HandleFunc("/health", health)
    
    log.Printf("Product service starting on port %s", port)
    log.Fatal(http.ListenAndServe(":"+port, nil))
}
```

Create a `Dockerfile` in the same directory:

```dockerfile
FROM golang:1.20-alpine AS builder

WORKDIR /app
COPY . .

RUN go mod init product-service
RUN go build -o product-service .

FROM alpine:3.17

WORKDIR /app
COPY --from=builder /app/product-service .

EXPOSE 8080
CMD ["./product-service"]
```

Now, build and push the Docker image:

```bash
docker build -t your-registry/product-service:v1 .
docker push your-registry/product-service:v1
```

### User Service

Create a `user-service` directory with these files:

```go
// main.go
package main

import (
    "encoding/json"
    "log"
    "net/http"
    "os"
    "sync"
)

type User struct {
    ID       string `json:"id"`
    Username string `json:"username"`
    Email    string `json:"email"`
}

var (
    users = []User{
        {ID: "1", Username: "johndoe", Email: "john@example.com"},
        {ID: "2", Username: "janedoe", Email: "jane@example.com"},
    }
    mu sync.RWMutex
)

func getUsers(w http.ResponseWriter, r *http.Request) {
    mu.RLock()
    defer mu.RUnlock()
    
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(users)
}

func getUser(w http.ResponseWriter, r *http.Request) {
    id := r.URL.Path[len("/users/"):]
    
    mu.RLock()
    defer mu.RUnlock()
    
    for _, user := range users {
        if user.ID == id {
            w.Header().Set("Content-Type", "application/json")
            json.NewEncoder(w).Encode(user)
            return
        }
    }
    
    w.WriteHeader(http.StatusNotFound)
    w.Write([]byte(`{"error": "User not found"}`))
}

func health(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusOK)
    w.Write([]byte(`{"status": "ok"}`))
}

func main() {
    port := os.Getenv("PORT")
    if port == "" {
        port = "8080"
    }
    
    http.HandleFunc("/users", getUsers)
    http.HandleFunc("/users/", getUser)
    http.HandleFunc("/health", health)
    
    log.Printf("User service starting on port %s", port)
    log.Fatal(http.ListenAndServe(":"+port, nil))
}
```

Create a `Dockerfile` similar to the one for the product service, then build and push the image.

### Order Service

The order service will be more complex as it needs to communicate with both the product and user services:

```go
// main.go
package main

import (
    "encoding/json"
    "fmt"
    "io/ioutil"
    "log"
    "net/http"
    "os"
    "sync"
    "time"
)

type Order struct {
    ID        string    `json:"id"`
    UserID    string    `json:"user_id"`
    Products  []Product `json:"products"`
    Total     float64   `json:"total"`
    Status    string    `json:"status"`
    CreatedAt time.Time `json:"created_at"`
}

type Product struct {
    ID       string  `json:"id"`
    Name     string  `json:"name"`
    Price    float64 `json:"price"`
    Quantity int     `json:"quantity"`
}

type User struct {
    ID       string `json:"id"`
    Username string `json:"username"`
    Email    string `json:"email"`
}

var (
    orders = []Order{
        {
            ID:     "1",
            UserID: "1",
            Products: []Product{
                {ID: "1", Name: "Go Gopher Plush Toy", Price: 19.99, Quantity: 2},
            },
            Total:     39.98,
            Status:    "completed",
            CreatedAt: time.Now().Add(-24 * time.Hour),
        },
    }
    mu sync.RWMutex
)

func getOrders(w http.ResponseWriter, r *http.Request) {
    mu.RLock()
    defer mu.RUnlock()
    
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(orders)
}

func getOrder(w http.ResponseWriter, r *http.Request) {
    id := r.URL.Path[len("/orders/"):]
    
    mu.RLock()
    defer mu.RUnlock()
    
    for _, order := range orders {
        if order.ID == id {
            w.Header().Set("Content-Type", "application/json")
            json.NewEncoder(w).Encode(order)
            return
        }
    }
    
    w.WriteHeader(http.StatusNotFound)
    w.Write([]byte(`{"error": "Order not found"}`))
}

func createOrder(w http.ResponseWriter, r *http.Request) {
    if r.Method != http.MethodPost {
        w.WriteHeader(http.StatusMethodNotAllowed)
        return
    }
    
    var newOrder Order
    if err := json.NewDecoder(r.Body).Decode(&newOrder); err != nil {
        w.WriteHeader(http.StatusBadRequest)
        w.Write([]byte(`{"error": "Invalid request"}`))
        return
    }
    
    // Validate user exists
    userServiceURL := os.Getenv("USER_SERVICE_URL")
    if userServiceURL == "" {
        userServiceURL = "http://user-service:8080"
    }
    
    resp, err := http.Get(fmt.Sprintf("%s/users/%s", userServiceURL, newOrder.UserID))
    if err != nil || resp.StatusCode != http.StatusOK {
        w.WriteHeader(http.StatusBadRequest)
        w.Write([]byte(`{"error": "Invalid user"}`))
        return
    }
    
    // Calculate total
    newOrder.ID = fmt.Sprintf("%d", len(orders)+1)
    newOrder.CreatedAt = time.Now()
    newOrder.Status = "pending"
    
    mu.Lock()
    orders = append(orders, newOrder)
    mu.Unlock()
    
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusCreated)
    json.NewEncoder(w).Encode(newOrder)
}

func health(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusOK)
    w.Write([]byte(`{"status": "ok"}`))
}

func main() {
    port := os.Getenv("PORT")
    if port == "" {
        port = "8080"
    }
    
    http.HandleFunc("/orders", func(w http.ResponseWriter, r *http.Request) {
        if r.Method == http.MethodGet {
            getOrders(w, r)
        } else if r.Method == http.MethodPost {
            createOrder(w, r)
        } else {
            w.WriteHeader(http.StatusMethodNotAllowed)
        }
    })
    http.HandleFunc("/orders/", getOrder)
    http.HandleFunc("/health", health)
    
    log.Printf("Order service starting on port %s", port)
    log.Fatal(http.ListenAndServe(":"+port, nil))
}
```

Create a `Dockerfile` for this service as well.

### Frontend Service

For simplicity, we'll create a basic Go web server that serves static HTML and makes API calls to our services:

```go
// main.go
package main

import (
    "html/template"
    "log"
    "net/http"
    "os"
)

type PageData struct {
    Title string
}

func home(w http.ResponseWriter, r *http.Request) {
    tmpl, err := template.ParseFiles("templates/home.html")
    if err != nil {
        log.Printf("Error parsing template: %v", err)
        http.Error(w, "Internal Server Error", http.StatusInternalServerError)
        return
    }
    
    data := PageData{
        Title: "E-commerce Microservices Demo",
    }
    
    tmpl.Execute(w, data)
}

func health(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusOK)
    w.Write([]byte(`{"status": "ok"}`))
}

func main() {
    port := os.Getenv("PORT")
    if port == "" {
        port = "8080"
    }
    
    http.HandleFunc("/", home)
    http.HandleFunc("/health", health)
    
    // Serve static files
    fs := http.FileServer(http.Dir("./static"))
    http.Handle("/static/", http.StripPrefix("/static/", fs))
    
    log.Printf("Frontend service starting on port %s", port)
    log.Fatal(http.ListenAndServe(":"+port, nil))
}
```

Create a basic `templates/home.html` file and a `static` directory with some CSS.

## Part 2: Kubernetes Deployment Configuration

Now that we have our containerized services, let's create the Kubernetes configuration files to deploy them.

### Namespace

First, let's create a dedicated namespace for our application:

```yaml
# namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: ecommerce
```

Apply it with:

```bash
kubectl apply -f namespace.yaml
```

### ConfigMaps and Secrets

Let's create ConfigMaps and Secrets for our application:

```yaml
# configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
  namespace: ecommerce
data:
  PRODUCT_SERVICE_URL: "http://product-service:8080"
  USER_SERVICE_URL: "http://user-service:8080"
  ORDER_SERVICE_URL: "http://order-service:8080"
---
apiVersion: v1
kind: Secret
metadata:
  name: app-secrets
  namespace: ecommerce
type: Opaque
data:
  # Note: Values should be base64 encoded
  JWT_SECRET: c2VjcmV0LWtleQ== # "secret-key" in base64
```

### Product Service Deployment

Create the Kubernetes deployment and service for the product service:

```yaml
# product-service.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: product-service
  namespace: ecommerce
spec:
  replicas: 2
  selector:
    matchLabels:
      app: product-service
  template:
    metadata:
      labels:
        app: product-service
    spec:
      containers:
      - name: product-service
        image: your-registry/product-service:v1
        ports:
        - containerPort: 8080
        resources:
          limits:
            cpu: "0.5"
            memory: "512Mi"
          requests:
            cpu: "0.1"
            memory: "128Mi"
        env:
        - name: PORT
          value: "8080"
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 15
          periodSeconds: 20
        readinessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 10
---
apiVersion: v1
kind: Service
metadata:
  name: product-service
  namespace: ecommerce
spec:
  selector:
    app: product-service
  ports:
  - port: 8080
    targetPort: 8080
  type: ClusterIP
```

### User Service Deployment

Create the deployment and service for the user service:

```yaml
# user-service.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: user-service
  namespace: ecommerce
spec:
  replicas: 2
  selector:
    matchLabels:
      app: user-service
  template:
    metadata:
      labels:
        app: user-service
    spec:
      containers:
      - name: user-service
        image: your-registry/user-service:v1
        ports:
        - containerPort: 8080
        resources:
          limits:
            cpu: "0.5"
            memory: "512Mi"
          requests:
            cpu: "0.1"
            memory: "128Mi"
        env:
        - name: PORT
          value: "8080"
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 15
          periodSeconds: 20
        readinessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 10
---
apiVersion: v1
kind: Service
metadata:
  name: user-service
  namespace: ecommerce
spec:
  selector:
    app: user-service
  ports:
  - port: 8080
    targetPort: 8080
  type: ClusterIP
```

### Order Service Deployment

Create the deployment and service for the order service:

```yaml
# order-service.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-service
  namespace: ecommerce
spec:
  replicas: 2
  selector:
    matchLabels:
      app: order-service
  template:
    metadata:
      labels:
        app: order-service
    spec:
      containers:
      - name: order-service
        image: your-registry/order-service:v1
        ports:
        - containerPort: 8080
        resources:
          limits:
            cpu: "0.5"
            memory: "512Mi"
          requests:
            cpu: "0.1"
            memory: "128Mi"
        env:
        - name: PORT
          value: "8080"
        - name: USER_SERVICE_URL
          valueFrom:
            configMapKeyRef:
              name: app-config
              key: USER_SERVICE_URL
        - name: PRODUCT_SERVICE_URL
          valueFrom:
            configMapKeyRef:
              name: app-config
              key: PRODUCT_SERVICE_URL
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 15
          periodSeconds: 20
        readinessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 10
---
apiVersion: v1
kind: Service
metadata:
  name: order-service
  namespace: ecommerce
spec:
  selector:
    app: order-service
  ports:
  - port: 8080
    targetPort: 8080
  type: ClusterIP
```

### Frontend Service Deployment

Finally, create the deployment and service for the frontend:

```yaml
# frontend.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: frontend
  namespace: ecommerce
spec:
  replicas: 2
  selector:
    matchLabels:
      app: frontend
  template:
    metadata:
      labels:
        app: frontend
    spec:
      containers:
      - name: frontend
        image: your-registry/frontend:v1
        ports:
        - containerPort: 8080
        resources:
          limits:
            cpu: "0.5"
            memory: "512Mi"
          requests:
            cpu: "0.1"
            memory: "128Mi"
        env:
        - name: PORT
          value: "8080"
        - name: PRODUCT_SERVICE_URL
          valueFrom:
            configMapKeyRef:
              name: app-config
              key: PRODUCT_SERVICE_URL
        - name: USER_SERVICE_URL
          valueFrom:
            configMapKeyRef:
              name: app-config
              key: USER_SERVICE_URL
        - name: ORDER_SERVICE_URL
          valueFrom:
            configMapKeyRef:
              name: app-config
              key: ORDER_SERVICE_URL
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 15
          periodSeconds: 20
        readinessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 10
---
apiVersion: v1
kind: Service
metadata:
  name: frontend
  namespace: ecommerce
spec:
  selector:
    app: frontend
  ports:
  - port: 80
    targetPort: 8080
  type: ClusterIP
```

### Ingress Configuration

To expose our frontend service to external traffic, we'll create an Ingress resource:

```yaml
# ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ecommerce-ingress
  namespace: ecommerce
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
spec:
  rules:
  - host: ecommerce.example.com  # Replace with your domain
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: frontend
            port:
              number: 80
      - path: /api/products
        pathType: Prefix
        backend:
          service:
            name: product-service
            port:
              number: 8080
      - path: /api/users
        pathType: Prefix
        backend:
          service:
            name: user-service
            port:
              number: 8080
      - path: /api/orders
        pathType: Prefix
        backend:
          service:
            name: order-service
            port:
              number: 8080
```

## Part 3: Deploying to Kubernetes

Now let's deploy our application to Kubernetes:

```bash
# Apply all configurations
kubectl apply -f namespace.yaml
kubectl apply -f configmap.yaml
kubectl apply -f product-service.yaml
kubectl apply -f user-service.yaml
kubectl apply -f order-service.yaml
kubectl apply -f frontend.yaml
kubectl apply -f ingress.yaml
```

Verify that all pods are running:

```bash
kubectl get pods -n ecommerce
```

You should see output similar to:

```
NAME                               READY   STATUS    RESTARTS   AGE
frontend-7d9f6d8f44-2xvqp          1/1     Running   0          45s
frontend-7d9f6d8f44-l8mxz          1/1     Running   0          45s
order-service-6c9fb5f5d7-8gqvn     1/1     Running   0          60s
order-service-6c9fb5f5d7-vq2cz     1/1     Running   0          60s
product-service-7c8f94f4c7-kpd8h   1/1     Running   0          75s
product-service-7c8f94f4c7-xvbdq   1/1     Running   0          75s
user-service-5d87bf6cd9-29nhp      1/1     Running   0          67s
user-service-5d87bf6cd9-wgrz4      1/1     Running   0          67s
```

## Part 4: Advanced Kubernetes Features for Go Applications

### Horizontal Pod Autoscaling

Go applications are lightweight and can scale efficiently. Let's add horizontal pod autoscaling to our product service:

```yaml
# product-service-hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: product-service-hpa
  namespace: ecommerce
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: product-service
  minReplicas: 2
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
```

Apply the HPA:

```bash
kubectl apply -f product-service-hpa.yaml
```

### Persistent Storage for Go Applications

While our simple services don't need persistent storage, in a real-world scenario, you might need it for databases or file storage. Here's an example of a PersistentVolumeClaim and how to use it with a Go application:

```yaml
# product-storage.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: product-data
  namespace: ecommerce
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
```

Then update the deployment to use it:

```yaml
# Updated section from product-service.yaml
spec:
  containers:
  - name: product-service
    # ...other configuration...
    volumeMounts:
    - name: product-data
      mountPath: /app/data
  volumes:
  - name: product-data
    persistentVolumeClaim:
      claimName: product-data
```

### Implementing Health Checks in Go

We already added basic health checks to our services, but let's improve them with more detailed readiness and liveness probes. Here's an expanded health check handler for Go:

```go
func health(w http.ResponseWriter, r *http.Request) {
    // Check dependencies
    dbHealthy := checkDatabaseConnection()
    dependenciesHealthy := checkExternalServices()
    
    if r.URL.Path == "/health/live" {
        // Liveness check - just verify the app is running
        w.WriteHeader(http.StatusOK)
        w.Write([]byte(`{"status": "ok"}`))
        return
    }
    
    // Readiness check - verify it can service requests
    if !dbHealthy || !dependenciesHealthy {
        w.WriteHeader(http.StatusServiceUnavailable)
        w.Write([]byte(`{"status": "not ready", "message": "dependencies not available"}`))
        return
    }
    
    w.WriteHeader(http.StatusOK)
    w.Write([]byte(`{"status": "ready"}`))
}

func checkDatabaseConnection() bool {
    // In a real app, check your DB connection
    return true
}

func checkExternalServices() bool {
    // Check if dependent services are available
    return true
}
```

Then update the probes in your deployment:

```yaml
livenessProbe:
  httpGet:
    path: /health/live
    port: 8080
  initialDelaySeconds: 15
  periodSeconds: 20
readinessProbe:
  httpGet:
    path: /health/ready
    port: 8080
  initialDelaySeconds: 5
  periodSeconds: 10
```

### Graceful Shutdown in Go for Kubernetes

Kubernetes sends SIGTERM signals to pods when they need to be terminated. Make sure your Go applications handle this gracefully:

```go
func main() {
    // ... initialization code ...
    
    server := &http.Server{
        Addr:    ":" + port,
        Handler: router,
    }
    
    // Start server in a goroutine so we can handle shutdown
    go func() {
        log.Printf("Server starting on port %s", port)
        if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
            log.Fatalf("Server failed: %v", err)
        }
    }()
    
    // Set up channel to listen for signals
    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
    
    // Block until signal is received
    <-quit
    log.Println("Server shutting down...")
    
    // Create context with timeout for outstanding requests
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()
    
    // Attempt graceful shutdown
    if err := server.Shutdown(ctx); err != nil {
        log.Fatalf("Server forced to shutdown: %v", err)
    }
    
    log.Println("Server exited gracefully")
}
```

This ensures that ongoing requests are completed before the pod is terminated.

## Part 5: Monitoring Go Applications in Kubernetes

### Prometheus Metrics in Go

Let's add Prometheus metrics to our Go services using the `prometheus/client_golang` package:

```go
import (
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
    "github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
    httpRequestsTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "http_requests_total",
            Help: "Total number of HTTP requests",
        },
        []string{"method", "endpoint", "status"},
    )
    
    httpRequestDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "http_request_duration_seconds",
            Help:    "Duration of HTTP requests in seconds",
            Buckets: prometheus.DefBuckets,
        },
        []string{"method", "endpoint"},
    )
)

func metricsMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()
        
        // Create a response writer that captures the status code
        ww := &responseWriterCapture{ResponseWriter: w, statusCode: http.StatusOK}
        
        // Call the next handler
        next.ServeHTTP(ww, r)
        
        // Record metrics
        duration := time.Since(start).Seconds()
        httpRequestsTotal.WithLabelValues(r.Method, r.URL.Path, fmt.Sprintf("%d", ww.statusCode)).Inc()
        httpRequestDuration.WithLabelValues(r.Method, r.URL.Path).Observe(duration)
    })
}

// Response writer that captures the status code
type responseWriterCapture struct {
    http.ResponseWriter
    statusCode int
}

func (rwc *responseWriterCapture) WriteHeader(statusCode int) {
    rwc.statusCode = statusCode
    rwc.ResponseWriter.WriteHeader(statusCode)
}

func main() {
    // ... other initialization ...
    
    // Add Prometheus metrics endpoint
    http.Handle("/metrics", promhttp.Handler())
    
    // Apply metrics middleware to all routes
    router := http.NewServeMux()
    router.Handle("/products", metricsMiddleware(http.HandlerFunc(getProducts)))
    router.Handle("/products/", metricsMiddleware(http.HandlerFunc(getProduct)))
    router.Handle("/health", metricsMiddleware(http.HandlerFunc(health)))
    router.Handle("/metrics", promhttp.Handler())
    
    // ... server startup code ...
}
```

Now update your service to expose the metrics port:

```yaml
# product-service.yaml update
apiVersion: v1
kind: Service
metadata:
  name: product-service
  namespace: ecommerce
  annotations:
    prometheus.io/scrape: "true"
    prometheus.io/port: "8080"
    prometheus.io/path: "/metrics"
spec:
  selector:
    app: product-service
  ports:
  - name: http
    port: 8080
    targetPort: 8080
  - name: metrics
    port: 9090
    targetPort: 8080
  type: ClusterIP
```

### Deploying Prometheus and Grafana

Let's set up monitoring with Prometheus and Grafana:

```yaml
# prometheus.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: prometheus-config
  namespace: monitoring
data:
  prometheus.yml: |
    global:
      scrape_interval: 15s
    scrape_configs:
      - job_name: 'kubernetes-pods'
        kubernetes_sd_configs:
          - role: pod
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
            regex: (.+):(?:\d+);(\d+)
            replacement: ${1}:${2}
            target_label: __address__
          - source_labels: [__meta_kubernetes_namespace]
            action: replace
            target_label: kubernetes_namespace
          - source_labels: [__meta_kubernetes_pod_name]
            action: replace
            target_label: kubernetes_pod_name
```

## Part 6: CI/CD Pipeline for Go Microservices on Kubernetes

Here's a sample GitHub Actions workflow for our Go microservices:

```yaml
# .github/workflows/ci-cd.yaml
name: CI/CD Pipeline

on:
  push:
    branches: [ main ]
  pull_request:
    branches: [ main ]

jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        service: [product-service, user-service, order-service, frontend]
    
    steps:
    - uses: actions/checkout@v3
    
    - name: Set up Go
      uses: actions/setup-go@v3
      with:
        go-version: '1.20'
    
    - name: Build and Test
      run: |
        cd ${{ matrix.service }}
        go mod init ${{ matrix.service }}
        go mod tidy
        go build -v ./...
        go test -v ./...
    
    - name: Set up Docker Buildx
      uses: docker/setup-buildx-action@v2
    
    - name: Login to DockerHub
      uses: docker/login-action@v2
      with:
        username: ${{ secrets.DOCKERHUB_USERNAME }}
        password: ${{ secrets.DOCKERHUB_TOKEN }}
    
    - name: Build and push
      uses: docker/build-push-action@v3
      with:
        context: ./${{ matrix.service }}
        push: true
        tags: your-registry/${{ matrix.service }}:${{ github.sha }},your-registry/${{ matrix.service }}:latest
  
  deploy:
    needs: build
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    
    steps:
    - uses: actions/checkout@v3
    
    - name: Set up kubectl
      uses: azure/setup-kubectl@v3
      with:
        version: 'latest'
    
    - name: Set up kubeconfig
      run: |
        mkdir -p $HOME/.kube
        echo "${{ secrets.KUBE_CONFIG }}" > $HOME/.kube/config
        chmod 600 $HOME/.kube/config
    
    - name: Update Kubernetes deployments with new image
      run: |
        kubectl set image deployment/product-service product-service=your-registry/product-service:${{ github.sha }} -n ecommerce
        kubectl set image deployment/user-service user-service=your-registry/user-service:${{ github.sha }} -n ecommerce
        kubectl set image deployment/order-service order-service=your-registry/order-service:${{ github.sha }} -n ecommerce
        kubectl set image deployment/frontend frontend=your-registry/frontend:${{ github.sha }} -n ecommerce
    
    - name: Verify deployments
      run: |
        kubectl rollout status deployment/product-service -n ecommerce
        kubectl rollout status deployment/user-service -n ecommerce
        kubectl rollout status deployment/order-service -n ecommerce
        kubectl rollout status deployment/frontend -n ecommerce
```

## Part 7: Security Best Practices for Go Applications in Kubernetes

### Network Policies

Restrict communication between pods with network policies:

```yaml
# network-policy.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny
  namespace: ecommerce
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  - Egress
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: product-service-policy
  namespace: ecommerce
spec:
  podSelector:
    matchLabels:
      app: product-service
  policyTypes:
  - Ingress
  - Egress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: frontend
    - podSelector:
        matchLabels:
          app: order-service
    ports:
    - protocol: TCP
      port: 8080
  egress:
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
      podSelector:
        matchLabels:
          k8s-app: kube-dns
    ports:
    - protocol: UDP
      port: 53
    - protocol: TCP
      port: 53
```

### Security Context

Add security context to your deployments:

```yaml
# Updated security section in product-service.yaml
spec:
  containers:
  - name: product-service
    # ...other config...
    securityContext:
      readOnlyRootFilesystem: true
      runAsNonRoot: true
      runAsUser: 10001
      capabilities:
        drop:
        - ALL
```

### Secure Secrets Management

Use a dedicated secrets management solution like HashiCorp Vault instead of Kubernetes secrets for sensitive information. Here's an example of integrating with Vault:

1. Install the Vault Injector:

```bash
helm repo add hashicorp https://helm.releases.hashicorp.com
helm install vault hashicorp/vault --set "injector.enabled=true"
```

2. Update your deployment to use the Vault injector:

```yaml
# Updated product-service.yaml with Vault annotations
metadata:
  annotations:
    vault.hashicorp.com/agent-inject: "true"
    vault.hashicorp.com/agent-inject-secret-database-config.json: "database/creds/product-service"
    vault.hashicorp.com/role: "product-service"
```

## Conclusion

In this comprehensive guide, we've covered the complete process of deploying Go microservices to Kubernetes. From building containerized services to setting up monitoring, scaling, and security, you now have the knowledge to deploy robust Go applications on Kubernetes.

The combination of Go's efficiency and Kubernetes' orchestration capabilities creates a powerful platform for building scalable, resilient microservices.

Key takeaways:

1. Go's small binary sizes and minimal runtime dependencies make it ideal for containerization
2. Kubernetes provides the orchestration layer to manage deployments, scaling, and networking
3. Health checks and graceful shutdown are essential for reliable Go applications in Kubernetes
4. Monitoring with Prometheus enables visibility into your applications' performance
5. Security must be considered at all layers: network, container, and application

As you continue building and deploying Go applications on Kubernetes, remember that the ecosystem continues to evolve. Stay updated with the latest best practices in both Go and Kubernetes to ensure your applications remain secure, performant, and maintainable.

Happy deploying!