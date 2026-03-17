---
title: "Kubernetes API Aggregation Layer: Custom API Servers with apiserver-builder and kube-aggregator"
date: 2030-05-13T00:00:00-05:00
draft: false
tags: ["Kubernetes", "API Aggregation", "Custom API Server", "apiserver-builder", "kube-aggregator", "Go"]
categories: ["Kubernetes", "Development"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to building custom Kubernetes API servers using the aggregation layer: apiserver-builder framework, authentication delegation to kube-apiserver, authorization webhooks, etcd storage for custom resources, and production deployment."
more_link: "yes"
url: "/kubernetes-api-aggregation-layer-custom-api-servers-apiserver-builder/"
---

The Kubernetes API aggregation layer enables extending the Kubernetes API surface with custom API servers that appear to clients as native Kubernetes APIs. Unlike Custom Resource Definitions (CRDs), which store resources in the Kubernetes etcd and use the standard Kubernetes storage machinery, aggregated API servers maintain their own storage backends, implement custom validation logic, and provide sub-resources that are impossible to express with CRDs.

This guide covers the complete aggregated API server stack: how kube-aggregator proxies requests to extension API servers, how authentication and authorization delegation works, building a production-quality API server with apiserver-builder, etcd storage integration, and common patterns for deciding between CRDs and aggregated API servers.

<!--more-->

## API Aggregation Architecture

### How kube-aggregator Works

```
Client Request to Custom API:

  kubectl get --raw /apis/database.example.com/v1alpha1/databases

  ┌─────────────────────────────────────────────────────────────────────┐
  │                     kube-apiserver                                   │
  │                                                                     │
  │  1. Receives request for /apis/database.example.com/v1alpha1/*      │
  │  2. kube-aggregator checks APIService registry:                     │
  │     - APIService: database.example.com/v1alpha1                     │
  │     - Spec.Service.Name: database-apiserver                         │
  │     - Spec.Service.Namespace: kube-system                           │
  │     - Spec.CABundle: <certificate>                                  │
  │  3. Proxies request to database-apiserver service                   │
  │     WITH authentication headers:                                    │
  │     - X-Remote-User: system:admin                                   │
  │     - X-Remote-Group: system:masters                                │
  │                                                                     │
  └──────────────────┬──────────────────────────────────────────────────┘
                     │ Proxy
                     ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │                    Custom API Server                                 │
  │                                                                     │
  │  4. Validates identity via TokenReview or header trust              │
  │  5. Performs authorization via SubjectAccessReview                  │
  │  6. Handles request against custom storage (etcd or other)          │
  │  7. Returns response - kube-aggregator forwards to client           │
  └─────────────────────────────────────────────────────────────────────┘
```

### When to Use Aggregated API Servers vs CRDs

```
CRDs (Custom Resource Definitions):
  - Simple storage of custom resource types
  - Defaulting and validation via CEL or webhooks
  - No custom API endpoints (only standard CRUD + watch)
  - Stored in main Kubernetes etcd
  - No sub-resource complexity
  - BEST FOR: 95% of operator use cases

Aggregated API Servers:
  - Custom storage backend (different etcd cluster, external DB)
  - Non-standard sub-resources (/exec, /logs, custom actions)
  - Custom protocol handling (WebSocket, chunked transfer)
  - Fine-grained validation that's impossible in CEL
  - Custom admission control tightly coupled to business logic
  - Namespace-independent resources (cluster-level only)
  - BEST FOR: Platform-level extensions (metrics-server, service-catalog)

Examples of Aggregated API Servers in production:
  - metrics-server (/apis/metrics.k8s.io/v1beta1)
  - custom-metrics-apiserver (/apis/custom.metrics.k8s.io/v1beta2)
  - kube-aggregator itself (/apis/apiregistration.k8s.io/v1)
```

## APIService Registration

### Registering Your API Server

```yaml
# apiservice-registration.yaml
apiVersion: apiregistration.k8s.io/v1
kind: APIService
metadata:
  name: v1alpha1.database.example.com
spec:
  # Group and version this APIService handles
  group: database.example.com
  version: v1alpha1

  # Priority: lower values = higher priority when aggregating
  groupPriorityMinimum: 100
  versionPriority: 15

  # Where kube-aggregator sends requests
  service:
    name: database-apiserver
    namespace: kube-system
    port: 443

  # CA bundle used to verify the custom API server's TLS certificate
  # If insecureSkipTLSVerify: true, skip this (NOT for production)
  caBundle: <certificate-pem-content>
  insecureSkipTLSVerify: false
```

```bash
# Verify APIService status
kubectl get apiservice v1alpha1.database.example.com -o yaml

# Check if the APIService is available
kubectl get apiservice v1alpha1.database.example.com \
    -o jsonpath='{.status.conditions[?(@.type=="Available")].status}'
# Should output: True

# List all registered API services
kubectl get apiservice
```

## Building with apiserver-builder

### Project Initialization

```bash
# Install apiserver-builder
go install sigs.k8s.io/apiserver-builder-alpha/cmd/apiserver-boot@latest

# Initialize a new API server project
mkdir database-apiserver && cd database-apiserver
go mod init github.com/example/database-apiserver

# Initialize the apiserver-builder project
apiserver-boot init repo --domain database.example.com

# Create an API group and version
apiserver-boot create group version resource \
    --group database \
    --version v1alpha1 \
    --kind Database

# The tool generates:
# - pkg/apis/database/v1alpha1/database_types.go  (resource types)
# - pkg/apis/database/v1alpha1/database_rest.go   (REST strategy)
# - pkg/controller/database/database_controller.go (reconciler)
# - main.go (server entry point)
# - Dockerfile
```

### Resource Type Definition

```go
// pkg/apis/database/v1alpha1/database_types.go
package v1alpha1

import (
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/apimachinery/pkg/runtime/schema"
)

// DatabaseSpec defines the desired state of a Database.
type DatabaseSpec struct {
    // Engine is the database engine type.
    // +kubebuilder:validation:Enum=postgres;mysql;mariadb
    Engine string `json:"engine"`

    // Version is the database engine version.
    Version string `json:"version"`

    // StorageGB is the storage allocation in gigabytes.
    // +kubebuilder:validation:Minimum=1
    StorageGB int32 `json:"storageGB"`
}

// DatabaseStatus is the observed state of a Database.
type DatabaseStatus struct {
    Phase   string `json:"phase,omitempty"`
    Endpoint string `json:"endpoint,omitempty"`
}

// +genclient
// +k8s:deepcopy-gen:interfaces=k8s.io/apimachinery/pkg/runtime.Object
type Database struct {
    metav1.TypeMeta   `json:",inline"`
    metav1.ObjectMeta `json:"metadata,omitempty"`

    Spec   DatabaseSpec   `json:"spec,omitempty"`
    Status DatabaseStatus `json:"status,omitempty"`
}

// +k8s:deepcopy-gen:interfaces=k8s.io/apimachinery/pkg/runtime.Object
type DatabaseList struct {
    metav1.TypeMeta `json:",inline"`
    metav1.ListMeta `json:"metadata,omitempty"`
    Items           []Database `json:"items"`
}

// SchemeGroupVersion is the group and version for this package.
var SchemeGroupVersion = schema.GroupVersion{
    Group:   "database.example.com",
    Version: "v1alpha1",
}

// Resource returns a GroupResource for the given resource type.
func Resource(resource string) schema.GroupResource {
    return SchemeGroupVersion.WithResource(resource).GroupResource()
}

// Implement runtime.Object interface
func (d *Database) DeepCopyObject() runtime.Object {
    if d == nil {
        return nil
    }
    out := new(Database)
    d.DeepCopyInto(out)
    return out
}
```

### REST Strategy Implementation

```go
// pkg/apis/database/v1alpha1/database_rest.go
package v1alpha1

import (
    "context"
    "fmt"

    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/apimachinery/pkg/util/validation/field"
    "k8s.io/apiserver/pkg/registry/rest"
    "sigs.k8s.io/apiserver-builder-alpha/pkg/builders"
)

// DatabaseStrategy implements rest.RESTCreateStrategy, rest.RESTUpdateStrategy.
type DatabaseStrategy struct {
    runtime.ObjectTyper
    builders.DefaultStorageStrategy
}

var Strategy = DatabaseStrategy{builders.Scheme, builders.DefaultStorageStrategy{}}

// NamespaceScoped returns true because Databases are namespace-scoped.
func (DatabaseStrategy) NamespaceScoped() bool { return true }

// PrepareForCreate sets default values on create.
func (DatabaseStrategy) PrepareForCreate(ctx context.Context, obj runtime.Object) {
    db := obj.(*Database)

    // Set defaults
    if db.Spec.StorageGB == 0 {
        db.Spec.StorageGB = 10 // Default 10GB storage
    }

    // Clear status on create
    db.Status = DatabaseStatus{}
}

// PrepareForUpdate resets fields that cannot be changed after creation.
func (DatabaseStrategy) PrepareForUpdate(ctx context.Context, obj, old runtime.Object) {
    newDB := obj.(*Database)
    oldDB := old.(*Database)

    // Engine cannot be changed after creation (immutable field)
    newDB.Spec.Engine = oldDB.Spec.Engine

    // Preserve existing status
    newDB.Status = oldDB.Status
}

// Validate validates a Database object on create.
func (DatabaseStrategy) Validate(ctx context.Context, obj runtime.Object) field.ErrorList {
    db := obj.(*Database)
    return validateDatabase(db)
}

// ValidateUpdate validates a Database object on update.
func (DatabaseStrategy) ValidateUpdate(ctx context.Context, obj, old runtime.Object) field.ErrorList {
    newDB := obj.(*Database)
    oldDB := old.(*Database)
    return validateDatabaseUpdate(newDB, oldDB)
}

// Canonicalize normalizes the object after it passes validation.
func (DatabaseStrategy) Canonicalize(obj runtime.Object) {}

func validateDatabase(db *Database) field.ErrorList {
    var allErrs field.ErrorList

    if db.Spec.Engine == "" {
        allErrs = append(allErrs, field.Required(
            field.NewPath("spec", "engine"),
            "engine is required",
        ))
    }

    if db.Spec.Version == "" {
        allErrs = append(allErrs, field.Required(
            field.NewPath("spec", "version"),
            "version is required",
        ))
    }

    if db.Spec.StorageGB < 1 {
        allErrs = append(allErrs, field.Invalid(
            field.NewPath("spec", "storageGB"),
            db.Spec.StorageGB,
            "must be at least 1",
        ))
    }

    if db.Spec.StorageGB > 10000 {
        allErrs = append(allErrs, field.Invalid(
            field.NewPath("spec", "storageGB"),
            db.Spec.StorageGB,
            fmt.Sprintf("must not exceed 10000 (requested %d GB)", db.Spec.StorageGB),
        ))
    }

    return allErrs
}

func validateDatabaseUpdate(newDB, oldDB *Database) field.ErrorList {
    var allErrs field.ErrorList

    // Engine is immutable
    if newDB.Spec.Engine != oldDB.Spec.Engine {
        allErrs = append(allErrs, field.Forbidden(
            field.NewPath("spec", "engine"),
            "engine cannot be changed after creation",
        ))
    }

    // StorageGB can only increase
    if newDB.Spec.StorageGB < oldDB.Spec.StorageGB {
        allErrs = append(allErrs, field.Invalid(
            field.NewPath("spec", "storageGB"),
            newDB.Spec.StorageGB,
            fmt.Sprintf("cannot decrease storage (was %d GB)", oldDB.Spec.StorageGB),
        ))
    }

    return allErrs
}
```

## Authentication Delegation

### Delegating Authentication to kube-apiserver

```go
// server/auth.go
package server

import (
    "context"
    "fmt"
    "net/http"

    authenticationv1 "k8s.io/api/authentication/v1"
    authorizationv1 "k8s.io/api/authorization/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/client-go/kubernetes"
    "k8s.io/apiserver/pkg/authentication/authenticator"
    "k8s.io/apiserver/pkg/authorization/authorizer"
    "k8s.io/apiserver/pkg/endpoints/request"
)

// DelegatingAuthenticator validates requests by forwarding to kube-apiserver's
// TokenReview API. This means we trust kube-apiserver's authentication decisions.
type DelegatingAuthenticator struct {
    client kubernetes.Interface
}

func NewDelegatingAuthenticator(client kubernetes.Interface) *DelegatingAuthenticator {
    return &DelegatingAuthenticator{client: client}
}

func (a *DelegatingAuthenticator) AuthenticateRequest(req *http.Request) (*authenticator.Response, bool, error) {
    // For aggregated API servers, kube-aggregator injects user identity as headers:
    // X-Remote-User: the authenticated user
    // X-Remote-Group: the user's groups (can be multiple)
    // X-Remote-Extra-: additional attributes

    user := req.Header.Get("X-Remote-User")
    if user == "" {
        return nil, false, nil
    }

    groups := req.Header["X-Remote-Group"]

    // Extract extra attributes
    extra := make(map[string]authenticationv1.ExtraValue)
    for key, values := range req.Header {
        if len(key) > len("X-Remote-Extra-") &&
            key[:len("X-Remote-Extra-")] == "X-Remote-Extra-" {
            extraKey := key[len("X-Remote-Extra-"):]
            extra[extraKey] = authenticationv1.ExtraValue(values)
        }
    }

    info := &authenticator.Response{
        User: &request.DefaultUser{
            Name:   user,
            Groups: groups,
            Extra:  extra,
        },
    }

    return info, true, nil
}

// DelegatingAuthorizer checks authorization by performing SubjectAccessReview
// against kube-apiserver. This delegates authorization policy to Kubernetes RBAC.
type DelegatingAuthorizer struct {
    client kubernetes.Interface
}

func NewDelegatingAuthorizer(client kubernetes.Interface) *DelegatingAuthorizer {
    return &DelegatingAuthorizer{client: client}
}

func (a *DelegatingAuthorizer) Authorize(
    ctx context.Context,
    attrs authorizer.Attributes,
) (authorizer.Decision, string, error) {
    user := attrs.GetUser()
    if user == nil {
        return authorizer.DecisionDeny, "no user found", nil
    }

    // Perform SubjectAccessReview
    sar := &authorizationv1.SubjectAccessReview{
        Spec: authorizationv1.SubjectAccessReviewSpec{
            User:   user.GetName(),
            Groups: user.GetGroups(),
            ResourceAttributes: &authorizationv1.ResourceAttributes{
                Namespace:   attrs.GetNamespace(),
                Verb:        attrs.GetVerb(),
                Group:       attrs.GetAPIGroup(),
                Version:     attrs.GetAPIVersion(),
                Resource:    attrs.GetResource(),
                Subresource: attrs.GetSubresource(),
                Name:        attrs.GetName(),
            },
        },
    }

    result, err := a.client.AuthorizationV1().
        SubjectAccessReviews().
        Create(ctx, sar, metav1.CreateOptions{})
    if err != nil {
        return authorizer.DecisionNoOpinion, "", fmt.Errorf("SAR failed: %w", err)
    }

    if result.Status.Allowed {
        return authorizer.DecisionAllow, result.Status.Reason, nil
    }

    if result.Status.Denied {
        return authorizer.DecisionDeny, result.Status.Reason, nil
    }

    return authorizer.DecisionNoOpinion, result.Status.Reason, nil
}
```

## etcd Storage Integration

### Custom etcd Storage Backend

```go
// storage/etcd.go
package storage

import (
    "context"
    "fmt"

    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/apimachinery/pkg/runtime/schema"
    "k8s.io/apiserver/pkg/registry/generic"
    genericregistry "k8s.io/apiserver/pkg/registry/generic/registry"
    "k8s.io/apiserver/pkg/registry/rest"
    "k8s.io/apiserver/pkg/storage/storagebackend"

    databasev1alpha1 "github.com/example/database-apiserver/pkg/apis/database/v1alpha1"
)

// DatabaseStorage implements the etcd-backed storage for Database resources.
type DatabaseStorage struct {
    *genericregistry.Store
}

// NewDatabaseStorage creates a new etcd-backed storage for Database resources.
func NewDatabaseStorage(
    scheme *runtime.Scheme,
    optsGetter generic.RESTOptionsGetter,
) (*DatabaseStorage, *DatabaseStatus, error) {
    strategy := databasev1alpha1.Strategy

    store := &genericregistry.Store{
        NewFunc:                  func() runtime.Object { return &databasev1alpha1.Database{} },
        NewListFunc:              func() runtime.Object { return &databasev1alpha1.DatabaseList{} },
        DefaultQualifiedResource: databasev1alpha1.Resource("databases"),

        // Lifecycle hooks
        CreateStrategy: strategy,
        UpdateStrategy: strategy,
        DeleteStrategy: strategy,

        // Table converter for kubectl output
        TableConvertor: rest.NewDefaultTableConvertor(databasev1alpha1.Resource("databases")),
    }

    options := &generic.StoreOptions{
        RESTOptions: optsGetter,
    }

    if err := store.CompleteWithOptions(options); err != nil {
        return nil, nil, fmt.Errorf("completing store options: %w", err)
    }

    statusStrategy := databasev1alpha1.DatabaseStatusStrategy{Strategy: strategy}
    statusStore := *store
    statusStore.UpdateStrategy = statusStrategy
    statusStore.ResetFieldsStrategy = statusStrategy

    return &DatabaseStorage{store}, &DatabaseStatus{&statusStore}, nil
}

// Implement the REST interface methods

func (ds *DatabaseStorage) New() runtime.Object {
    return &databasev1alpha1.Database{}
}

func (ds *DatabaseStorage) NewList() runtime.Object {
    return &databasev1alpha1.DatabaseList{}
}

func (ds *DatabaseStorage) Destroy() {
    ds.Store.Destroy()
}
```

### Configuring etcd Connection

```go
// server/etcd.go
package server

import (
    "k8s.io/apiserver/pkg/server/options"
    "k8s.io/apiserver/pkg/storage/storagebackend"
)

func buildStorageOptions() *options.EtcdOptions {
    etcdOpts := options.NewEtcdOptions(
        storagebackend.NewDefaultConfig("/registry", nil),
    )

    // Custom etcd endpoints (separate from main cluster if desired)
    etcdOpts.StorageConfig.Transport.ServerList = []string{
        "https://etcd-0.etcd.kube-system.svc.cluster.local:2379",
        "https://etcd-1.etcd.kube-system.svc.cluster.local:2379",
        "https://etcd-2.etcd.kube-system.svc.cluster.local:2379",
    }

    // TLS configuration for etcd connection
    etcdOpts.StorageConfig.Transport.CertFile = "/etc/etcd/client.crt"
    etcdOpts.StorageConfig.Transport.KeyFile = "/etc/etcd/client.key"
    etcdOpts.StorageConfig.Transport.TrustedCAFile = "/etc/etcd/ca.crt"

    // Prefix for keys in etcd (avoid collision with kube-apiserver)
    etcdOpts.StorageConfig.Prefix = "/registry/database-apiserver"

    // Compaction interval (0 = disabled, let etcd handle it)
    etcdOpts.CompactionInterval = 0

    return etcdOpts
}
```

## Main Server Entry Point

### Complete API Server Setup

```go
// main.go
package main

import (
    "flag"
    "os"

    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/apimachinery/pkg/runtime/schema"
    genericapiserver "k8s.io/apiserver/pkg/server"
    "k8s.io/apiserver/pkg/server/options"
    "k8s.io/client-go/kubernetes"
    "k8s.io/client-go/rest"
    "k8s.io/component-base/logs"

    databasev1alpha1 "github.com/example/database-apiserver/pkg/apis/database/v1alpha1"
    "github.com/example/database-apiserver/pkg/apiserver"
)

func main() {
    logs.InitLogs()
    defer logs.FlushLogs()

    if err := runServer(); err != nil {
        os.Exit(1)
    }
}

func runServer() error {
    // Server options with secure serving defaults
    serverOpts := genericapiserver.NewRecommendedOptions(
        "/registry/database-apiserver",
        databasev1alpha1.Codec,
    )

    // Parse flags
    fs := flag.NewFlagSet("database-apiserver", flag.ExitOnError)
    serverOpts.AddFlags(fs)
    fs.Parse(os.Args[1:])

    // Build server config
    config, err := serverOpts.Config()
    if err != nil {
        return fmt.Errorf("building server config: %w", err)
    }

    // Create in-cluster client for delegation
    restConfig, err := rest.InClusterConfig()
    if err != nil {
        return fmt.Errorf("getting cluster config: %w", err)
    }

    k8sClient, err := kubernetes.NewForConfig(restConfig)
    if err != nil {
        return fmt.Errorf("creating k8s client: %w", err)
    }

    // Configure delegating authentication and authorization
    config.GenericConfig.Authentication.Authenticator =
        NewDelegatingAuthenticator(k8sClient)
    config.GenericConfig.Authorization.Authorizer =
        NewDelegatingAuthorizer(k8sClient)

    // Build the server
    server, err := apiserver.New(config, genericapiserver.NewEmptyDelegate())
    if err != nil {
        return fmt.Errorf("building server: %w", err)
    }

    return server.GenericAPIServer.PrepareRun().Run(genericapiserver.SetupSignalHandler())
}
```

## Deployment Configuration

### Kubernetes Deployment for Custom API Server

```yaml
# deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: database-apiserver
  namespace: kube-system
spec:
  replicas: 2
  selector:
    matchLabels:
      app: database-apiserver
  template:
    metadata:
      labels:
        app: database-apiserver
    spec:
      serviceAccountName: database-apiserver
      priorityClassName: system-cluster-critical
      containers:
      - name: apiserver
        image: registry.example.com/database-apiserver:v1.0.0
        command:
        - /database-apiserver
        - --secure-port=443
        - --tls-cert-file=/etc/tls/tls.crt
        - --tls-private-key-file=/etc/tls/tls.key
        - --etcd-servers=https://etcd-0.etcd:2379,https://etcd-1.etcd:2379
        - --etcd-cafile=/etc/etcd/ca.crt
        - --etcd-certfile=/etc/etcd/client.crt
        - --etcd-keyfile=/etc/etcd/client.key
        - --authentication-kubeconfig=/etc/kubernetes/auth-kubeconfig
        - --authorization-kubeconfig=/etc/kubernetes/auth-kubeconfig
        - --requestheader-client-ca-file=/etc/kubernetes/requestheader-ca.crt
        - --requestheader-allowed-names=front-proxy-client
        - --requestheader-extra-headers-prefix=X-Remote-Extra-
        - --requestheader-group-headers=X-Remote-Group
        - --requestheader-username-headers=X-Remote-User
        ports:
        - containerPort: 443
          name: https
        livenessProbe:
          httpGet:
            path: /healthz
            port: 443
            scheme: HTTPS
          initialDelaySeconds: 15
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /readyz
            port: 443
            scheme: HTTPS
          initialDelaySeconds: 5
          periodSeconds: 5
        volumeMounts:
        - name: tls
          mountPath: /etc/tls
          readOnly: true
        - name: etcd-certs
          mountPath: /etc/etcd
          readOnly: true
        - name: auth-config
          mountPath: /etc/kubernetes
          readOnly: true
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 512Mi
      volumes:
      - name: tls
        secret:
          secretName: database-apiserver-tls
      - name: etcd-certs
        secret:
          secretName: etcd-certs
      - name: auth-config
        configMap:
          name: auth-config
---
apiVersion: v1
kind: Service
metadata:
  name: database-apiserver
  namespace: kube-system
spec:
  selector:
    app: database-apiserver
  ports:
  - port: 443
    targetPort: 443
    name: https
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: database-apiserver
  namespace: kube-system
---
# RBAC for the API server's service account
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: database-apiserver:auth-delegator
roleRef:
  kind: ClusterRole
  name: system:auth-delegator
  apiGroup: rbac.authorization.k8s.io
subjects:
- kind: ServiceAccount
  name: database-apiserver
  namespace: kube-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: database-apiserver:auth-reader
  namespace: kube-system
roleRef:
  kind: Role
  name: extension-apiserver-authentication-reader
  apiGroup: rbac.authorization.k8s.io
subjects:
- kind: ServiceAccount
  name: database-apiserver
  namespace: kube-system
```

## Troubleshooting

### Diagnosing APIService Issues

```bash
# Check APIService status
kubectl get apiservice -l kube-aggregator.kubernetes.io/automanaged!=onstart

# Detailed status
kubectl describe apiservice v1alpha1.database.example.com

# Common issues:
# 1. APIService Available=False: custom API server is unreachable
kubectl get endpoints database-apiserver -n kube-system
kubectl logs deployment/database-apiserver -n kube-system

# 2. TLS certificate issues
# Verify the CA bundle in APIService matches the certificate
openssl verify -CAfile <(kubectl get apiservice v1alpha1.database.example.com \
    -o jsonpath='{.spec.caBundle}' | base64 -d) \
    <(kubectl exec -n kube-system deployment/database-apiserver -- \
    cat /etc/tls/tls.crt)

# 3. Authentication delegation failing
# Check that the service account has system:auth-delegator binding
kubectl get clusterrolebinding database-apiserver:auth-delegator

# 4. Test the API server directly
kubectl run debug --image=curlimages/curl:latest --restart=Never --rm -it -- \
    curl -sk https://database-apiserver.kube-system.svc.cluster.local/healthz

# 5. Check kube-apiserver logs for proxy errors
kubectl logs -n kube-system kube-apiserver-<node> | grep "database.example.com"

# Verify discovery works
kubectl api-resources | grep database.example.com
kubectl api-versions | grep database.example.com

# Make a test request
kubectl get databases -A
kubectl create -f - <<EOF
apiVersion: database.example.com/v1alpha1
kind: Database
metadata:
  name: test-db
  namespace: default
spec:
  engine: postgres
  version: "16"
  storageGB: 100
EOF
```

### Health Endpoints

```go
// health.go - Add health check endpoints
package server

import (
    "net/http"

    "k8s.io/apiserver/pkg/server"
    "k8s.io/apiserver/pkg/server/healthz"
)

// AddHealthChecks registers health endpoints with the generic API server.
func AddHealthChecks(s *server.GenericAPIServer, checks ...healthz.HealthChecker) {
    // /healthz - liveness probe
    s.AddHealthChecks(checks...)

    // /readyz - readiness probe (includes storage connectivity)
    s.AddReadyzChecks(
        healthz.NewInformerSyncHealthz(s.SharedInformerFactory),
        &etcdHealthCheck{},
    )
}

type etcdHealthCheck struct{}

func (e *etcdHealthCheck) Name() string { return "etcd" }

func (e *etcdHealthCheck) Check(req *http.Request) error {
    // Verify etcd connectivity
    // In production: ping etcd with a short timeout
    return nil
}
```

## Key Takeaways

Kubernetes aggregated API servers provide the most powerful extension point in the Kubernetes ecosystem, at the cost of significantly higher implementation complexity compared to CRDs.

**Choose aggregated API servers only when CRDs cannot express your requirements**: The 95% use case for extending Kubernetes is served by CRDs with validation webhooks and custom controllers. Aggregated API servers are warranted for custom sub-resources (think `/exec`, `/log`, `/proxy` equivalents), custom storage backends, or resources that need tight validation logic that CEL cannot express.

**Authentication and authorization delegation is the cornerstone of aggregation security**: Your custom API server should never implement its own authentication or authorization. Delegating TokenReview to kube-apiserver for authentication and SubjectAccessReview for authorization ensures that your API server respects the same RBAC policies as the rest of the cluster.

**The RequestHeader authentication flow is critical**: kube-aggregator authenticates the original user, then proxies the request to your API server with `X-Remote-User` and `X-Remote-Group` headers. Your server must validate these headers came from kube-aggregator (via the requestheader CA certificate) rather than a direct client.

**Separate etcd clusters improve availability isolation**: Running your custom API server against a separate etcd cluster means that issues with your extension (etcd OOM, corruption, maintenance) cannot affect the core Kubernetes control plane. This is especially important for platform-level extensions.

**The `system:auth-delegator` ClusterRoleBinding is mandatory**: Without this binding on your API server's service account, TokenReview and SubjectAccessReview calls will fail, making authentication and authorization impossible. Always verify this binding is present when debugging connectivity issues.
