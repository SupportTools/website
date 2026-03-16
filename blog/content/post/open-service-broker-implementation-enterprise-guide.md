---
title: "Open Service Broker API Implementation: Building Service Marketplaces for Kubernetes Platforms"
date: 2026-10-16T00:00:00-05:00
draft: false
tags: ["Open Service Broker", "OSBAPI", "Kubernetes", "Service Catalog", "Platform Engineering", "Microservices"]
categories: ["Platform Engineering", "Service Management"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to implementing Open Service Broker API for creating service marketplaces that provision and manage backing services in Kubernetes platforms."
more_link: "yes"
url: "/open-service-broker-implementation-enterprise-guide/"
---

The Open Service Broker API (OSBAPI) provides a standard way for platforms to provision and manage backing services. By implementing service brokers, platform teams can offer self-service catalogs of databases, message queues, and other dependencies. This guide demonstrates building production-grade service brokers for enterprise Kubernetes platforms.

<!--more-->

# Open Service Broker API Implementation: Building Service Marketplaces for Kubernetes Platforms

## Understanding Open Service Broker API

The Open Service Broker API defines a standard contract between platforms and service brokers, enabling:

- **Service Catalog**: Browseable catalog of available services
- **Provisioning**: On-demand service instance creation
- **Binding**: Generate credentials for applications
- **Deprovisioning**: Cleanup and resource deletion
- **Updates**: Modify existing service instances

### API Endpoints

```
GET    /v2/catalog              - List available services
PUT    /v2/service_instances/:id - Provision service instance
GET    /v2/service_instances/:id - Get service instance
PATCH  /v2/service_instances/:id - Update service instance
DELETE /v2/service_instances/:id - Deprovision service instance
PUT    /v2/service_instances/:id/service_bindings/:binding_id - Create binding
GET    /v2/service_instances/:id/service_bindings/:binding_id - Get binding
DELETE /v2/service_instances/:id/service_bindings/:binding_id - Delete binding
```

## Project Setup

### Go Service Broker Implementation

```go
// main.go
package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"

	"github.com/gorilla/mux"
	"github.com/pivotal-cf/brokerapi/v8"
	"github.com/pivotal-cf/brokerapi/v8/domain"
	"github.com/pivotal-cf/brokerapi/v8/middlewares"
)

type DatabaseBroker struct {
	config BrokerConfig
	store  Store
}

type BrokerConfig struct {
	Username string
	Password string
	Port     string
}

func main() {
	config := BrokerConfig{
		Username: os.Getenv("BROKER_USERNAME"),
		Password: os.Getenv("BROKER_PASSWORD"),
		Port:     getEnvOrDefault("PORT", "8080"),
	}

	store := NewPostgresStore()
	broker := &DatabaseBroker{
		config: config,
		store:  store,
	}

	credentials := brokerapi.BrokerCredentials{
		Username: config.Username,
		Password: config.Password,
	}

	brokerAPI := brokerapi.New(broker, nil, brokerapi.WithBrokerCredentials(credentials))
	
	router := mux.NewRouter()
	router.HandleFunc("/v2/catalog", brokerAPI.Catalog).Methods("GET")
	router.HandleFunc("/v2/service_instances/{instance_id}", brokerAPI.Provision).Methods("PUT")
	router.HandleFunc("/v2/service_instances/{instance_id}", brokerAPI.Deprovision).Methods("DELETE")
	router.HandleFunc("/v2/service_instances/{instance_id}/service_bindings/{binding_id}", brokerAPI.Bind).Methods("PUT")
	router.HandleFunc("/v2/service_instances/{instance_id}/service_bindings/{binding_id}", brokerAPI.Unbind).Methods("DELETE")
	router.HandleFunc("/v2/service_instances/{instance_id}", brokerAPI.Update).Methods("PATCH")
	router.HandleFunc("/v2/service_instances/{instance_id}/last_operation", brokerAPI.LastOperation).Methods("GET")

	log.Printf("Starting broker on port %s", config.Port)
	log.Fatal(http.ListenAndServe(":"+config.Port, router))
}

func getEnvOrDefault(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}
```

## Service Catalog Implementation

```go
// catalog.go
package main

import (
	"context"

	"github.com/pivotal-cf/brokerapi/v8/domain"
	"github.com/pivotal-cf/brokerapi/v8/domain/apiresponses"
)

func (b *DatabaseBroker) Services(ctx context.Context) ([]domain.Service, error) {
	return []domain.Service{
		{
			ID:            "postgresql-service-id",
			Name:          "postgresql",
			Description:   "PostgreSQL Database Service",
			Bindable:      true,
			PlanUpdatable: true,
			Tags:          []string{"postgresql", "database", "relational"},
			Metadata: &domain.ServiceMetadata{
				DisplayName:      "PostgreSQL",
				ImageUrl:         "https://example.com/postgresql-icon.png",
				LongDescription:  "Managed PostgreSQL database instances with automated backups and high availability",
				ProviderDisplayName: "Company Platform Team",
				DocumentationUrl: "https://docs.company.com/postgresql",
				SupportUrl:       "https://support.company.com",
			},
			Plans: []domain.ServicePlan{
				{
					ID:          "postgresql-small",
					Name:        "small",
					Description: "Small PostgreSQL instance (2 CPU, 4GB RAM, 20GB storage)",
					Free:        boolPtr(false),
					Bindable:    boolPtr(true),
					Metadata: &domain.ServicePlanMetadata{
						DisplayName: "Small",
						Bullets: []string{
							"2 CPU cores",
							"4GB RAM",
							"20GB storage",
							"Automated backups",
							"99.9% SLA",
						},
						Costs: []domain.ServicePlanCost{
							{
								Amount: map[string]float64{"usd": 50.00},
								Unit:   "MONTHLY",
							},
						},
					},
					Schemas: &domain.ServiceSchemas{
						Instance: domain.ServiceInstanceSchema{
							Create: domain.Schema{
								Parameters: map[string]interface{}{
									"$schema": "http://json-schema.org/draft-04/schema#",
									"type":    "object",
									"properties": map[string]interface{}{
										"backup_retention_days": map[string]interface{}{
											"type":        "integer",
											"minimum":     1,
											"maximum":     35,
											"default":     7,
											"description": "Number of days to retain backups",
										},
										"high_availability": map[string]interface{}{
											"type":        "boolean",
											"default":     false,
											"description": "Enable multi-AZ deployment",
										},
										"encryption": map[string]interface{}{
											"type":        "boolean",
											"default":     true,
											"description": "Enable encryption at rest",
										},
									},
								},
							},
							Update: domain.Schema{
								Parameters: map[string]interface{}{
									"$schema": "http://json-schema.org/draft-04/schema#",
									"type":    "object",
									"properties": map[string]interface{}{
										"backup_retention_days": map[string]interface{}{
											"type":    "integer",
											"minimum": 1,
											"maximum": 35,
										},
									},
								},
							},
						},
						Binding: domain.ServiceBindingSchema{
							Create: domain.Schema{
								Parameters: map[string]interface{}{
									"$schema": "http://json-schema.org/draft-04/schema#",
									"type":    "object",
									"properties": map[string]interface{}{
										"privileges": map[string]interface{}{
											"type": "array",
											"items": map[string]interface{}{
												"type": "string",
												"enum": []string{"READ", "WRITE", "ADMIN"},
											},
											"default": []string{"READ", "WRITE"},
										},
									},
								},
							},
						},
					},
				},
				{
					ID:          "postgresql-medium",
					Name:        "medium",
					Description: "Medium PostgreSQL instance (4 CPU, 16GB RAM, 100GB storage)",
					Free:        boolPtr(false),
					Bindable:    boolPtr(true),
					Metadata: &domain.ServicePlanMetadata{
						DisplayName: "Medium",
						Bullets: []string{
							"4 CPU cores",
							"16GB RAM",
							"100GB storage",
							"Automated backups",
							"High availability",
							"99.95% SLA",
						},
						Costs: []domain.ServicePlanCost{
							{
								Amount: map[string]float64{"usd": 200.00},
								Unit:   "MONTHLY",
							},
						},
					},
				},
				{
					ID:          "postgresql-large",
					Name:        "large",
					Description: "Large PostgreSQL instance (8 CPU, 32GB RAM, 500GB storage)",
					Free:        boolPtr(false),
					Bindable:    boolPtr(true),
					Metadata: &domain.ServicePlanMetadata{
						DisplayName: "Large",
						Bullets: []string{
							"8 CPU cores",
							"32GB RAM",
							"500GB storage",
							"Automated backups",
							"High availability",
							"Performance Insights",
							"99.99% SLA",
						},
						Costs: []domain.ServicePlanCost{
							{
								Amount: map[string]float64{"usd": 800.00},
								Unit:   "MONTHLY",
							},
						},
					},
				},
			},
		},
		{
			ID:            "redis-service-id",
			Name:          "redis",
			Description:   "Redis Cache Service",
			Bindable:      true,
			PlanUpdatable: true,
			Tags:          []string{"redis", "cache", "in-memory"},
			Metadata: &domain.ServiceMetadata{
				DisplayName:      "Redis",
				ImageUrl:         "https://example.com/redis-icon.png",
				LongDescription:  "Managed Redis cache instances with clustering and persistence options",
				ProviderDisplayName: "Company Platform Team",
			},
			Plans: []domain.ServicePlan{
				{
					ID:          "redis-small",
					Name:        "small",
					Description: "Small Redis instance (1GB memory)",
					Free:        boolPtr(false),
					Bindable:    boolPtr(true),
				},
				{
					ID:          "redis-medium",
					Name:        "medium",
					Description: "Medium Redis instance (5GB memory, replication)",
					Free:        boolPtr(false),
					Bindable:    boolPtr(true),
				},
			},
		},
	}, nil
}

func boolPtr(b bool) *bool {
	return &b
}
```

## Provisioning Implementation

```go
// provision.go
package main

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/pivotal-cf/brokerapi/v8/domain"
	"github.com/pivotal-cf/brokerapi/v8/domain/apiresponses"
)

type ProvisionParameters struct {
	BackupRetentionDays int  `json:"backup_retention_days"`
	HighAvailability    bool `json:"high_availability"`
	Encryption          bool `json:"encryption"`
}

func (b *DatabaseBroker) Provision(ctx context.Context, instanceID string, details domain.ProvisionDetails, asyncAllowed bool) (domain.ProvisionedServiceSpec, error) {
	// Parse parameters
	var params ProvisionParameters
	if len(details.RawParameters) > 0 {
		if err := json.Unmarshal(details.RawParameters, &params); err != nil {
			return domain.ProvisionedServiceSpec{}, apiresponses.ErrRawParamsInvalid
		}
	}

	// Set defaults
	if params.BackupRetentionDays == 0 {
		params.BackupRetentionDays = 7
	}
	if !params.Encryption {
		params.Encryption = true
	}

	// Check if instance already exists
	exists, err := b.store.InstanceExists(ctx, instanceID)
	if err != nil {
		return domain.ProvisionedServiceSpec{}, err
	}
	if exists {
		return domain.ProvisionedServiceSpec{}, apiresponses.ErrInstanceAlreadyExists
	}

	// Create instance asynchronously
	if asyncAllowed {
		// Start provisioning in background
		go func() {
			if err := b.provisionInstance(context.Background(), instanceID, details.ServiceID, details.PlanID, params); err != nil {
				// Log error and update status
				fmt.Printf("Failed to provision instance %s: %v\n", instanceID, err)
			}
		}()

		return domain.ProvisionedServiceSpec{
			IsAsync:       true,
			OperationData: "provisioning",
			DashboardURL:  fmt.Sprintf("https://console.company.com/databases/%s", instanceID),
		}, nil
	}

	// Synchronous provisioning
	if err := b.provisionInstance(ctx, instanceID, details.ServiceID, details.PlanID, params); err != nil {
		return domain.ProvisionedServiceSpec{}, err
	}

	return domain.ProvisionedServiceSpec{
		IsAsync:      false,
		DashboardURL: fmt.Sprintf("https://console.company.com/databases/%s", instanceID),
	}, nil
}

func (b *DatabaseBroker) provisionInstance(ctx context.Context, instanceID, serviceID, planID string, params ProvisionParameters) error {
	// Store instance metadata
	instance := ServiceInstance{
		ID:                  instanceID,
		ServiceID:           serviceID,
		PlanID:              planID,
		BackupRetentionDays: params.BackupRetentionDays,
		HighAvailability:    params.HighAvailability,
		Encryption:          params.Encryption,
		Status:              "creating",
	}

	if err := b.store.SaveInstance(ctx, instance); err != nil {
		return err
	}

	// Provision actual database (AWS RDS, Azure Database, etc.)
	dbInstance, err := b.provisionDatabase(ctx, instanceID, planID, params)
	if err != nil {
		instance.Status = "failed"
		instance.StatusMessage = err.Error()
		b.store.SaveInstance(ctx, instance)
		return err
	}

	// Update instance with connection details
	instance.Endpoint = dbInstance.Endpoint
	instance.Port = dbInstance.Port
	instance.Status = "available"
	return b.store.SaveInstance(ctx, instance)
}

func (b *DatabaseBroker) provisionDatabase(ctx context.Context, instanceID, planID string, params ProvisionParameters) (*DatabaseInstance, error) {
	// Implementation depends on cloud provider
	// Example for AWS RDS, Azure Database, etc.
	return &DatabaseInstance{
		Endpoint: fmt.Sprintf("%s.db.company.com", instanceID),
		Port:     5432,
	}, nil
}
```

## Binding Implementation

```go
// bind.go
package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"

	"github.com/pivotal-cf/brokerapi/v8/domain"
	"github.com/pivotal-cf/brokerapi/v8/domain/apiresponses"
)

type BindingCredentials struct {
	URI      string `json:"uri"`
	Username string `json:"username"`
	Password string `json:"password"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Database string `json:"database"`
}

func (b *DatabaseBroker) Bind(ctx context.Context, instanceID, bindingID string, details domain.BindDetails, asyncAllowed bool) (domain.Binding, error) {
	// Get instance
	instance, err := b.store.GetInstance(ctx, instanceID)
	if err != nil {
		return domain.Binding{}, apiresponses.ErrInstanceDoesNotExist
	}

	// Check if binding already exists
	exists, err := b.store.BindingExists(ctx, instanceID, bindingID)
	if err != nil {
		return domain.Binding{}, err
	}
	if exists {
		return domain.Binding{}, apiresponses.ErrBindingAlreadyExists
	}

	// Create database user and credentials
	username := fmt.Sprintf("user_%s", bindingID[:8])
	password := generatePassword(32)

	if err := b.createDatabaseUser(ctx, instance, username, password); err != nil {
		return domain.Binding{}, err
	}

	// Store binding
	binding := ServiceBinding{
		ID:         bindingID,
		InstanceID: instanceID,
		Username:   username,
		Password:   password,
	}
	if err := b.store.SaveBinding(ctx, binding); err != nil {
		return domain.Binding{}, err
	}

	// Return credentials
	credentials := BindingCredentials{
		URI:      fmt.Sprintf("postgresql://%s:%s@%s:%d/%s", username, password, instance.Endpoint, instance.Port, instanceID),
		Username: username,
		Password: password,
		Host:     instance.Endpoint,
		Port:     instance.Port,
		Database: instanceID,
	}

	return domain.Binding{
		Credentials: credentials,
	}, nil
}

func (b *DatabaseBroker) Unbind(ctx context.Context, instanceID, bindingID string, details domain.UnbindDetails, asyncAllowed bool) (domain.UnbindSpec, error) {
	// Get binding
	binding, err := b.store.GetBinding(ctx, instanceID, bindingID)
	if err != nil {
		return domain.UnbindSpec{}, apiresponses.ErrBindingDoesNotExist
	}

	// Get instance
	instance, err := b.store.GetInstance(ctx, instanceID)
	if err != nil {
		return domain.UnbindSpec{}, err
	}

	// Delete database user
	if err := b.deleteDatabaseUser(ctx, instance, binding.Username); err != nil {
		return domain.UnbindSpec{}, err
	}

	// Delete binding
	if err := b.store.DeleteBinding(ctx, instanceID, bindingID); err != nil {
		return domain.UnbindSpec{}, err
	}

	return domain.UnbindSpec{}, nil
}

func generatePassword(length int) string {
	bytes := make([]byte, length)
	rand.Read(bytes)
	return base64.URLEncoding.EncodeToString(bytes)[:length]
}

func (b *DatabaseBroker) createDatabaseUser(ctx context.Context, instance ServiceInstance, username, password string) error {
	// Implementation depends on database type
	// Execute SQL: CREATE USER, GRANT privileges
	return nil
}

func (b *DatabaseBroker) deleteDatabaseUser(ctx context.Context, instance ServiceInstance, username string) error {
	// Implementation depends on database type
	// Execute SQL: REVOKE privileges, DROP USER
	return nil
}
```

## Kubernetes Integration

### Service Catalog Installation

```yaml
# Install Service Catalog
apiVersion: v1
kind: Namespace
metadata:
  name: service-catalog
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: service-catalog
  namespace: service-catalog
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: service-catalog
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cluster-admin
subjects:
- kind: ServiceAccount
  name: service-catalog
  namespace: service-catalog
```

### Broker Registration

```yaml
# Register broker with Service Catalog
apiVersion: servicecatalog.k8s.io/v1beta1
kind: ClusterServiceBroker
metadata:
  name: database-broker
spec:
  url: https://database-broker.platform.svc.cluster.local
  authInfo:
    basic:
      secretRef:
        name: broker-credentials
        namespace: platform
  caBundle: LS0tLS1CRUdJTi... # base64 encoded CA cert
```

### Service Instance Creation

```yaml
# Create service instance
apiVersion: servicecatalog.k8s.io/v1beta1
kind: ServiceInstance
metadata:
  name: my-postgres-db
  namespace: my-app
spec:
  clusterServiceClassExternalName: postgresql
  clusterServicePlanExternalName: medium
  parameters:
    backup_retention_days: 14
    high_availability: true
    encryption: true
---
# Create service binding
apiVersion: servicecatalog.k8s.io/v1beta1
kind: ServiceBinding
metadata:
  name: my-postgres-binding
  namespace: my-app
spec:
  instanceRef:
    name: my-postgres-db
  secretName: postgres-credentials
```

### Application Usage

```yaml
# Application using bound service
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: my-app
spec:
  replicas: 3
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
      - name: app
        image: my-app:latest
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: postgres-credentials
              key: uri
        - name: DB_HOST
          valueFrom:
            secretKeyRef:
              name: postgres-credentials
              key: host
        - name: DB_PORT
          valueFrom:
            secretKeyRef:
              name: postgres-credentials
              key: port
        - name: DB_NAME
          valueFrom:
            secretKeyRef:
              name: postgres-credentials
              key: database
        - name: DB_USERNAME
          valueFrom:
            secretKeyRef:
              name: postgres-credentials
              key: username
        - name: DB_PASSWORD
          valueFrom:
            secretKeyRef:
              name: postgres-credentials
              key: password
```

## Best Practices

### Security
1. **Authentication**: Require basic auth or OAuth for broker API
2. **Encryption**: Use TLS for all communications
3. **Credential Rotation**: Support password rotation
4. **Least Privilege**: Grant minimal database permissions
5. **Audit Logging**: Log all provisioning operations

### Reliability
1. **Async Operations**: Use async mode for long-running operations
2. **Idempotency**: Support retries safely
3. **Status Tracking**: Implement LastOperation endpoint
4. **Error Handling**: Provide detailed error messages
5. **Health Checks**: Expose readiness and liveness probes

### Operational Excellence
1. **Monitoring**: Export Prometheus metrics
2. **Logging**: Structured logging with context
3. **Documentation**: Comprehensive service catalog metadata
4. **Cost Tracking**: Include pricing information
5. **SLA Definition**: Document availability guarantees

## Conclusion

Open Service Broker API enables standardized service provisioning across platforms. Key benefits include:

- **Self-Service**: Developers provision resources on-demand
- **Standardization**: Consistent interface across service types
- **Automation**: Reduce manual provisioning workflows
- **Governance**: Centralized control and auditing
- **Multi-Cloud**: Abstract cloud provider differences

Success requires robust implementation, comprehensive testing, and strong operational practices for managing the broker infrastructure.
