---
title: "Platform Engineering Golden Paths: Standardizing Developer Workflows"
date: 2027-10-24T00:00:00-05:00
draft: false
tags: ["Platform Engineering", "Golden Paths", "Developer Experience", "IDP", "DevOps"]
categories:
- Platform Engineering
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Golden path implementation for platform engineering covering Backstage scaffolder templates, self-service provisioning, automated security scanning, golden path metrics, CI/CD pipeline templates, and balancing standardization with autonomy."
more_link: "yes"
url: "/platform-engineering-golden-paths-guide/"
---

Golden paths are pre-paved, opinionated routes through an Internal Developer Platform (IDP) that encode organizational best practices. A well-designed golden path makes the right choice the easy choice — developers follow it not because they are required to, but because it is faster than building the same scaffolding themselves. This guide covers designing, implementing, and measuring golden paths that teams actually use.

<!--more-->

# Platform Engineering Golden Paths: Standardizing Developer Workflows

## Section 1: What a Golden Path Actually Is

A golden path is not a mandate. It is a complete, working starting point that satisfies security, compliance, and operational requirements out of the box. Teams that deviate from the golden path can do so, but they take on responsibility for the capabilities the path would have provided.

A mature golden path for a new microservice provides:

1. Repository scaffolding with linting, testing, and security scanning preconfigured.
2. A CI pipeline that runs tests, builds a container image, scans it, and pushes to the registry.
3. A Kubernetes deployment manifest with resource limits, health checks, RBAC, and NetworkPolicy.
4. Observability bootstrapping: a Grafana dashboard, alert rules, and Prometheus scrape config.
5. Service registration in the service catalog.
6. Documentation stub linked from the service catalog entry.

The golden path creates all of these in under five minutes via a self-service portal.

---

## Section 2: Backstage Scaffolder Templates

Backstage is the most widely deployed IDP framework. Its Software Templates (scaffolder) allow platform teams to codify golden paths as self-service wizards.

### Template Structure

```
templates/
  go-microservice/
    template.yaml          ← Backstage template definition
    skeleton/              ← Files copied into the new repository
      .github/
        workflows/
          ci.yaml
          security.yaml
      cmd/
        ${{ values.name }}/
          main.go
      internal/
        server/
          server.go
      Dockerfile
      Makefile
      README.md
      k8s/
        deployment.yaml
        service.yaml
        networkpolicy.yaml
```

### Template Definition

```yaml
# templates/go-microservice/template.yaml
apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
metadata:
  name: go-microservice
  title: Go Microservice
  description: Creates a new Go microservice with CI/CD, observability, and Kubernetes manifests.
  tags:
    - go
    - microservice
    - golden-path
spec:
  owner: platform-team
  type: service

  parameters:
    - title: Service Details
      required: [name, description, owner, system]
      properties:
        name:
          title: Service Name
          type: string
          description: Lowercase, hyphens only (e.g., order-processor)
          pattern: "^[a-z][a-z0-9-]{2,62}$"
          ui:autofocus: true
        description:
          title: Description
          type: string
          maxLength: 200
        owner:
          title: Owner Team
          type: string
          ui:field: OwnerPicker
          ui:options:
            allowedKinds: [Group]
        system:
          title: System
          type: string
          ui:field: EntityPicker
          ui:options:
            allowedKinds: [System]

    - title: Infrastructure
      properties:
        environment:
          title: Initial Environment
          type: string
          enum: [dev, staging]
          default: dev
        database:
          title: Requires PostgreSQL
          type: boolean
          default: false
        resources:
          title: Resource Profile
          type: string
          enum: [small, medium, large]
          default: small
          description: |
            small:  100m CPU / 128Mi RAM
            medium: 500m CPU / 512Mi RAM
            large:  1000m CPU / 1Gi RAM

    - title: Repository
      required: [repoUrl]
      properties:
        repoUrl:
          title: Repository Location
          type: string
          ui:field: RepoUrlPicker
          ui:options:
            allowedHosts:
              - github.com
            allowedOwners:
              - myorg

  steps:
    - id: fetch-base
      name: Fetch Base Template
      action: fetch:template
      input:
        url: ./skeleton
        values:
          name: ${{ parameters.name }}
          description: ${{ parameters.description }}
          owner: ${{ parameters.owner }}
          system: ${{ parameters.system }}
          environment: ${{ parameters.environment }}
          database: ${{ parameters.database }}
          resources: ${{ parameters.resources }}

    - id: publish
      name: Publish to GitHub
      action: publish:github
      input:
        allowedHosts: ["github.com"]
        description: ${{ parameters.description }}
        repoUrl: ${{ parameters.repoUrl }}
        defaultBranch: main
        repoVisibility: private
        requireCodeOwnerReviews: true
        requiredApprovingReviewCount: 1
        topics:
          - go
          - microservice
          - golden-path

    - id: register
      name: Register in Service Catalog
      action: catalog:register
      input:
        repoContentsUrl: ${{ steps['publish'].output.repoContentsUrl }}
        catalogInfoPath: /catalog-info.yaml

    - id: create-argocd-app
      name: Create ArgoCD Application
      action: argocd:create-resources
      input:
        projectName: ${{ parameters.owner }}
        appName: ${{ parameters.name }}-${{ parameters.environment }}
        repoUrl: ${{ steps['publish'].output.remoteUrl }}
        path: k8s/overlays/${{ parameters.environment }}
        namespace: ${{ parameters.name }}
        targetRevision: main

  output:
    links:
      - title: Repository
        url: ${{ steps['publish'].output.remoteUrl }}
      - title: Service in Catalog
        icon: catalog
        entityRef: ${{ steps['register'].output.entityRef }}
      - title: CI Pipeline
        url: ${{ steps['publish'].output.remoteUrl }}/actions
```

### Generated Kubernetes Deployment

```yaml
# templates/go-microservice/skeleton/k8s/base/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${{ values.name }}
  labels:
    app: ${{ values.name }}
    version: "1.0.0"
    part-of: ${{ values.system }}
    managed-by: backstage
spec:
  replicas: 2
  selector:
    matchLabels:
      app: ${{ values.name }}
  template:
    metadata:
      labels:
        app: ${{ values.name }}
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port:   "9090"
        prometheus.io/path:   "/metrics"
    spec:
      serviceAccountName: ${{ values.name }}
      securityContext:
        runAsNonRoot: true
        runAsUser: 65534
        fsGroup: 65534
      containers:
        - name: ${{ values.name }}
          image: ghcr.io/myorg/${{ values.name }}:latest
          ports:
            - containerPort: 8080
              name: http
            - containerPort: 9090
              name: metrics
          resources:
            requests:
              cpu:    "${{ values.resources == 'small' and '100m' or values.resources == 'medium' and '500m' or '1000m' }}"
              memory: "${{ values.resources == 'small' and '128Mi' or values.resources == 'medium' and '512Mi' or '1Gi' }}"
            limits:
              cpu:    "${{ values.resources == 'small' and '200m' or values.resources == 'medium' and '1000m' or '2000m' }}"
              memory: "${{ values.resources == 'small' and '256Mi' or values.resources == 'medium' and '1Gi' or '2Gi' }}"
          livenessProbe:
            httpGet:
              path: /health/live
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 10
            failureThreshold: 3
          readinessProbe:
            httpGet:
              path: /health/ready
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 5
            failureThreshold: 3
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
          env:
            - name: PORT
              value: "8080"
            - name: METRICS_PORT
              value: "9090"
            - name: APP_ENV
              valueFrom:
                fieldRef:
                  fieldPath: metadata.namespace
          volumeMounts:
            - name: tmp
              mountPath: /tmp
      volumes:
        - name: tmp
          emptyDir: {}
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: ${{ values.name }}
```

---

## Section 3: CI Pipeline Template

Every golden path service gets the same CI pipeline structure:

```yaml
# templates/go-microservice/skeleton/.github/workflows/ci.yaml
name: CI

on:
  push:
    branches: [main, release/*]
  pull_request:
    branches: [main]

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: myorg/${{ values.name }}

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_DB:       testdb
          POSTGRES_USER:     testuser
          POSTGRES_PASSWORD: testpass
        ports: ["5432:5432"]
        options: >-
          --health-cmd="pg_isready"
          --health-interval=5s
          --health-timeout=5s
          --health-retries=5
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version-file: go.mod
          cache: true
      - name: Lint
        uses: golangci/golangci-lint-action@v6
        with:
          version: latest
      - name: Test
        run: go test -race -coverprofile=coverage.out ./...
        env:
          DATABASE_URL: postgres://testuser:testpass@localhost:5432/testdb?sslmode=disable
      - name: Coverage gate
        run: |
          COVERAGE=$(go tool cover -func=coverage.out | tail -1 | awk '{print $3}' | tr -d '%')
          if (( $(echo "$COVERAGE < 70" | bc -l) )); then
            echo "Coverage ${COVERAGE}% is below 70% threshold"
            exit 1
          fi
          echo "Coverage: ${COVERAGE}%"

  security:
    runs-on: ubuntu-latest
    needs: test
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version-file: go.mod
      - name: govulncheck
        run: |
          go install golang.org/x/vuln/cmd/govulncheck@latest
          govulncheck ./...
      - name: gosec
        run: |
          go install github.com/securego/gosec/v2/cmd/gosec@latest
          gosec -severity medium -confidence high -exclude-generated ./...

  build:
    runs-on: ubuntu-latest
    needs: [test, security]
    permissions:
      contents: read
      packages: write
      id-token: write  # for keyless Cosign signing
    steps:
      - uses: actions/checkout@v4
      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3
      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: "${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}"
          tags: |
            type=sha,format=long
            type=ref,event=branch
            type=semver,pattern={{version}}
      - name: Build and push
        id: build
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
          provenance: true
          sbom: true
      - name: Scan with Trivy
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: "${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}@${{ steps.build.outputs.digest }}"
          format: sarif
          output: trivy-results.sarif
          severity: CRITICAL,HIGH
          exit-code: 1
      - name: Upload Trivy scan results
        uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: trivy-results.sarif
      - name: Sign image with Cosign
        uses: sigstore/cosign-installer@v3
      - name: Sign container image
        run: |
          cosign sign --yes \
            "${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}@${{ steps.build.outputs.digest }}"
```

---

## Section 4: Self-Service Database Provisioning

The golden path includes database provisioning via a Backstage action backed by a Crossplane claim:

```yaml
# backstage-action: provision-postgres
# This calls the platform API which creates a Crossplane PostgreSQLInstance claim.

# crossplane/postgres-claim.yaml (generated by the platform API)
apiVersion: platform.example.com/v1alpha1
kind: PostgreSQLInstance
metadata:
  name: ${{ values.name }}-db
  namespace: ${{ values.name }}
spec:
  parameters:
    storageGB: 20
    instanceClass: db.t3.medium
    backupRetentionDays: 7
    multiAZ: false  # set to true for production
  writeConnectionSecretToRef:
    name: ${{ values.name }}-db-credentials
    namespace: ${{ values.name }}
```

```yaml
# The Crossplane Composition maps the claim to an actual RDS instance or PostgreSQL operator:
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
metadata:
  name: postgresql-aws-rds
spec:
  compositeTypeRef:
    apiVersion: platform.example.com/v1alpha1
    kind: PostgreSQLInstance
  resources:
    - name: rds-instance
      base:
        apiVersion: rds.aws.upbound.io/v1beta1
        kind: Instance
        spec:
          forProvider:
            region: us-east-1
            engine: postgres
            engineVersion: "16.2"
            instanceClass: db.t3.medium
            autoMinorVersionUpgrade: true
            deletionProtection: true
            skipFinalSnapshot: false
            storageEncrypted: true
      patches:
        - fromFieldPath: spec.parameters.storageGB
          toFieldPath: spec.forProvider.allocatedStorage
        - fromFieldPath: spec.parameters.instanceClass
          toFieldPath: spec.forProvider.dbInstanceClass
        - fromFieldPath: spec.parameters.multiAZ
          toFieldPath: spec.forProvider.multiAZ
```

---

## Section 5: Golden Path Metrics

Measure golden path adoption and effectiveness:

```go
// platform/metrics/golden_path.go
package metrics

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	// GoldenPathAdoptions counts new services created via golden paths.
	GoldenPathAdoptions = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Namespace: "platform",
			Name:      "golden_path_adoptions_total",
			Help:      "Total services created via golden paths.",
		},
		[]string{"template", "team", "environment"},
	)

	// TimeToFirstDeployment measures how long it takes from golden path
	// initiation to first successful deployment.
	TimeToFirstDeployment = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Namespace: "platform",
			Name:      "time_to_first_deployment_seconds",
			Help:      "Duration from service creation to first deployment.",
			Buckets:   []float64{300, 600, 900, 1800, 3600, 7200},
		},
		[]string{"template", "team"},
	)

	// DeviationRate tracks teams that skip the golden path.
	DeviationRate = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Namespace: "platform",
			Name:      "golden_path_deviation_rate",
			Help:      "Fraction of services not using golden paths (0-1).",
		},
		[]string{"team"},
	)

	// SecurityGateFailures tracks CI pipeline security gate failures per template.
	SecurityGateFailures = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Namespace: "platform",
			Name:      "security_gate_failures_total",
			Help:      "Security scan failures in golden path CI pipelines.",
		},
		[]string{"template", "gate"},
	)
)
```

### Grafana Dashboard for Platform KPIs

```json
{
  "title": "Platform Engineering KPIs",
  "panels": [
    {
      "title": "Golden Path Adoption Rate (30d)",
      "type": "stat",
      "targets": [{
        "expr": "sum(increase(platform_golden_path_adoptions_total[30d]))"
      }]
    },
    {
      "title": "Median Time to First Deployment",
      "type": "stat",
      "targets": [{
        "expr": "histogram_quantile(0.50, sum(rate(platform_time_to_first_deployment_seconds_bucket[30d])) by (le)) / 60"
      }],
      "unit": "minutes"
    },
    {
      "title": "Teams Deviating from Golden Path",
      "type": "table",
      "targets": [{
        "expr": "platform_golden_path_deviation_rate > 0.2",
        "legendFormat": "{{ team }}"
      }]
    }
  ]
}
```

---

## Section 6: Observability Bootstrapping

Every golden path service gets a pre-configured Grafana dashboard and alert rules:

```yaml
# templates/go-microservice/skeleton/observability/alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: ${{ values.name }}-alerts
  namespace: ${{ values.name }}
  labels:
    prometheus: kube-prometheus
spec:
  groups:
    - name: ${{ values.name }}
      interval: 30s
      rules:
        - alert: HighErrorRate
          expr: |
            sum(rate(myapp_http_requests_total{job="${{ values.name }}", status_code=~"5.."}[5m]))
            /
            sum(rate(myapp_http_requests_total{job="${{ values.name }}"}[5m])) > 0.01
          for: 2m
          labels:
            severity: warning
            service: ${{ values.name }}
          annotations:
            summary: "Error rate above 1% for ${{ values.name }}"
            runbook_url: "https://wiki.example.com/runbooks/${{ values.name }}/high-error-rate"

        - alert: ServiceDown
          expr: up{job="${{ values.name }}"} == 0
          for: 1m
          labels:
            severity: critical
            service: ${{ values.name }}
          annotations:
            summary: "${{ values.name }} is down"
```

---

## Section 7: Balancing Standardization with Developer Autonomy

A golden path that is too rigid will be abandoned. The platform must support three tiers:

```
Tier 1: Paved (Golden Path)
  - Full self-service, zero-day security compliance
  - Platform team owns operations and upgrades
  - Cheapest path: teams focus on business logic

Tier 2: Supported (Deviation with Platform Blessing)
  - Team brings their own framework/language
  - Platform team reviews and provides advisory support
  - Team owns more operational responsibilities
  - Required: security scanning, observability, health checks

Tier 3: Unsupported (Full Ownership)
  - Complete custom implementation
  - Team owns all security, compliance, operations
  - Must pass quarterly security review
  - Limited to teams with >3 senior engineers
```

### Deviation Request Process

```yaml
# deviation-request.yaml — filed as a GitHub issue via template
name: Golden Path Deviation Request
about: Request approval to deviate from the platform golden path
title: "[DEVIATION] Service: <name> - Reason: <brief reason>"

body:
  - type: input
    id: service
    attributes:
      label: Service Name
      description: Name of the service requesting deviation
    validations:
      required: true

  - type: dropdown
    id: deviation_type
    attributes:
      label: Deviation Type
      options:
        - Language/Framework
        - Build System
        - Deployment Model
        - Observability
        - Security Scanning
    validations:
      required: true

  - type: textarea
    id: justification
    attributes:
      label: Business Justification
      description: Why is the golden path insufficient for this use case?
    validations:
      required: true

  - type: textarea
    id: alternatives
    attributes:
      label: Alternatives Considered
      description: What golden path options were evaluated and rejected?
    validations:
      required: true

  - type: textarea
    id: mitigations
    attributes:
      label: Risk Mitigations
      description: How will the team meet the security/compliance requirements the golden path would have provided?
    validations:
      required: true
```

---

## Section 8: Platform API for Programmatic Access

Beyond the Backstage UI, expose a platform API so teams can provision resources from their own tooling:

```go
// platform/api/handler.go
package api

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"myapp/platform/provisioner"
)

type CreateServiceRequest struct {
	Name        string `json:"name"   validate:"required,pattern=^[a-z][a-z0-9-]{2,62}$"`
	Template    string `json:"template" validate:"required,oneof=go-microservice python-fastapi nodejs-express"`
	Owner       string `json:"owner"  validate:"required"`
	Environment string `json:"environment" validate:"required,oneof=dev staging"`
	Database    bool   `json:"database"`
	Resources   string `json:"resources" validate:"required,oneof=small medium large"`
}

type CreateServiceResponse struct {
	ServiceID      string `json:"service_id"`
	RepositoryURL  string `json:"repository_url"`
	DashboardURL   string `json:"dashboard_url"`
	CatalogURL     string `json:"catalog_url"`
	EstimatedReady string `json:"estimated_ready_seconds"`
}

func (h *Handler) CreateService(w http.ResponseWriter, r *http.Request) {
	var req CreateServiceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	if errs := validate(req); errs != nil {
		w.WriteHeader(http.StatusUnprocessableEntity)
		json.NewEncoder(w).Encode(map[string]interface{}{"errors": errs})
		return
	}

	// Check authorization — only the owner team can provision.
	claims, _ := authClaimsFromContext(r.Context())
	if !claims.HasTeam(req.Owner) {
		http.Error(w, "forbidden: not a member of "+req.Owner, http.StatusForbidden)
		return
	}

	result, err := h.provisioner.CreateService(r.Context(), provisioner.ServiceRequest{
		Name:        req.Name,
		Template:    req.Template,
		Owner:       req.Owner,
		Environment: req.Environment,
		Database:    req.Database,
		Resources:   req.Resources,
	})
	if err != nil {
		http.Error(w, "provisioning failed: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	json.NewEncoder(w).Encode(CreateServiceResponse{
		ServiceID:      result.ServiceID,
		RepositoryURL:  result.RepositoryURL,
		DashboardURL:   result.DashboardURL,
		CatalogURL:     result.CatalogURL,
		EstimatedReady: "300",
	})
}
```

The golden path investment pays off when it becomes the default choice because it is the fastest choice. Teams that build around it spend their engineering capacity on business value, not on rebuilding the same CI, security scanning, and Kubernetes manifests for the hundredth time.

---

## Section 9: Network Policy Golden Path

Every golden path service gets a default NetworkPolicy that follows a zero-trust network model:

```yaml
# templates/go-microservice/skeleton/k8s/base/networkpolicy.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${{ values.name }}-default
  namespace: ${{ values.name }}
spec:
  podSelector:
    matchLabels:
      app: ${{ values.name }}
  policyTypes:
    - Ingress
    - Egress
  ingress:
    # Allow traffic from the ingress controller
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ingress-system
      ports:
        - port: 8080
    # Allow Prometheus scraping from the monitoring namespace
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: monitoring
      ports:
        - port: 9090
  egress:
    # Allow DNS resolution
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
      ports:
        - port: 53
          protocol: UDP
        - port: 53
          protocol: TCP
    # Allow calls to other services in the same namespace
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ${{ values.name }}
    # Allow calls to shared infrastructure namespaces
    - to:
        - namespaceSelector:
            matchLabels:
              platform-service: "true"
```

---

## Section 10: Golden Path for Data Engineering Teams

A separate golden path for data pipelines (Airflow/Prefect DAGs) provides different defaults:

```yaml
# templates/data-pipeline/template.yaml (abbreviated)
apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
metadata:
  name: data-pipeline
  title: Data Pipeline
  description: Creates a new data pipeline with Airflow DAG scaffolding and data quality gates.
  tags:
    - python
    - data-engineering
    - golden-path
spec:
  owner: data-platform-team
  type: data-pipeline

  parameters:
    - title: Pipeline Details
      required: [name, schedule, owner]
      properties:
        name:
          title: Pipeline Name
          type: string
          pattern: "^[a-z][a-z0-9_]{2,62}$"
        schedule:
          title: Cron Schedule
          type: string
          default: "0 6 * * *"
        source_dataset:
          title: Source Dataset
          type: string
          ui:field: EntityPicker
          ui:options:
            allowedKinds: [Resource]
            defaultKind: Resource
        sla_hours:
          title: Data Freshness SLA (hours)
          type: integer
          default: 4
          minimum: 1
          maximum: 48

  steps:
    - id: fetch-base
      name: Fetch Pipeline Template
      action: fetch:template
      input:
        url: ./skeleton
        values:
          name: ${{ parameters.name }}
          schedule: ${{ parameters.schedule }}
          source_dataset: ${{ parameters.source_dataset }}
          sla_hours: ${{ parameters.sla_hours }}
          owner: ${{ parameters.owner }}
```

---

## Section 11: Golden Path Adoption Analytics

Track which teams are using golden paths and which are building custom solutions using the Backstage catalog API:

```go
// platform/analytics/adoption.go
package analytics

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// CatalogClient fetches entity data from Backstage.
type CatalogClient struct {
	baseURL    string
	httpClient *http.Client
}

type Entity struct {
	Kind     string            `json:"kind"`
	Metadata EntityMetadata    `json:"metadata"`
	Spec     map[string]interface{} `json:"spec"`
}

type EntityMetadata struct {
	Name        string            `json:"name"`
	Namespace   string            `json:"namespace"`
	Labels      map[string]string `json:"labels"`
	Annotations map[string]string `json:"annotations"`
	Tags        []string          `json:"tags"`
}

// GetGoldenPathAdoptionRate returns the fraction of services using golden paths.
func (c *CatalogClient) GetGoldenPathAdoptionRate(ctx context.Context) (float64, error) {
	all, err := c.listComponents(ctx)
	if err != nil {
		return 0, err
	}

	total := 0
	goldenPath := 0
	for _, e := range all {
		if e.Kind != "Component" {
			continue
		}
		total++
		for _, tag := range e.Metadata.Tags {
			if tag == "golden-path" {
				goldenPath++
				break
			}
		}
	}

	if total == 0 {
		return 0, nil
	}
	return float64(goldenPath) / float64(total), nil
}

func (c *CatalogClient) listComponents(ctx context.Context) ([]Entity, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		c.baseURL+"/api/catalog/entities?filter=kind=Component", nil)
	if err != nil {
		return nil, err
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("catalog API: %w", err)
	}
	defer resp.Body.Close()

	var entities []Entity
	if err := json.NewDecoder(resp.Body).Decode(&entities); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}
	return entities, nil
}
```
