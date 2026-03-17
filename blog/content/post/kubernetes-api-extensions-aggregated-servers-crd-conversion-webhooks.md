---
title: "Kubernetes API Extensions: Aggregated API Servers and CRD Conversion Webhooks"
date: 2029-03-20T00:00:00-05:00
draft: false
tags: ["Kubernetes", "CRD", "API Extensions", "Webhooks", "Operators", "Go"]
categories:
- Kubernetes
- Platform Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep dive into Kubernetes API aggregation and CRD conversion webhooks, covering how to build custom API servers with the apiserver-builder SDK, implement multi-version CRDs, and operate conversion webhooks safely in production clusters."
more_link: "yes"
url: "/kubernetes-api-extensions-aggregated-servers-crd-conversion-webhooks/"
---

Kubernetes ships with a rich set of built-in APIs, yet every non-trivial platform team eventually reaches the boundary of what core resources can express. Two extension mechanisms close that gap: **Aggregated API Servers** allow entirely new API groups to be registered with the main API server as peers, while **CRD Conversion Webhooks** let a single custom resource type evolve across multiple versions without breaking existing consumers. Both mechanisms are production features available since Kubernetes 1.16 and 1.13 respectively, yet they are frequently misunderstood or avoided due to their operational complexity.

This guide builds working examples of each mechanism, discusses the failure modes that appear at scale, and provides the operational runbooks needed to keep these extension points healthy in long-running clusters.

<!--more-->

## Why API Extensions Matter

Before diving into implementation, it is worth understanding when each mechanism applies.

**Use Aggregated API Servers when:**
- The custom resource needs server-side field validation beyond what CRD OpenAPI schemas provide
- Sub-resources with custom semantics (not just `/status` and `/scale`) are required
- Fine-grained admission, watch filtering, or conversion logic is tightly coupled to storage
- The resource lifecycle requires custom garbage-collection finalizers driven by server logic
- Full audit log integration with per-verb action codes is mandatory

**Use CRD Conversion Webhooks when:**
- An existing CRD must add or rename fields across an API version bump
- Multiple tenants consume different API versions simultaneously
- Tooling (e.g., Helm charts) uses `v1alpha1` while the operator itself has moved to `v1`

The two mechanisms are complementary. Aggregated API servers can themselves serve multiple API versions and invoke conversion logic, while CRD conversion webhooks are the simpler path when the CRD development model is preferred.

---

## Part 1: CRD Conversion Webhooks

### Version Concepts

Every CRD has a **storage version**—the single version in which objects are persisted to etcd. All other versions are **served** versions. When a client reads an object stored at `v1` using the `v1alpha1` API, the API server must convert it. If no webhook is configured, the API server attempts a best-effort field-name pass-through, which works only for trivially compatible versions.

The conversion webhook is a standard HTTPS admission webhook that receives a `ConversionReview` request and returns a `ConversionReview` response.

### Defining a Multi-Version CRD

```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: databases.data.example.com
spec:
  group: data.example.com
  scope: Namespaced
  names:
    plural: databases
    singular: database
    kind: Database
    shortNames:
      - db
  versions:
    - name: v1alpha1
      served: true
      storage: false
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              properties:
                engine:
                  type: string
                  enum: [postgres, mysql, sqlite]
                storageGB:
                  type: integer
                  minimum: 1
    - name: v1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              required: [engine, storage]
              properties:
                engine:
                  type: string
                  enum: [postgres, mysql, sqlite]
                storage:
                  type: object
                  required: [capacityGB]
                  properties:
                    capacityGB:
                      type: integer
                      minimum: 1
                    storageClass:
                      type: string
  conversion:
    strategy: Webhook
    webhook:
      conversionReviewVersions: ["v1"]
      clientConfig:
        service:
          namespace: platform-system
          name: database-webhook
          path: /convert
          port: 443
        caBundle: "LS0tLS1CRUd..."   # base64-encoded CA cert
```

Key points in this YAML:
- `storage: true` on `v1` means new objects are written in `v1` format.
- `storage: false` on `v1alpha1` means objects stored as `v1alpha1` (from before the migration) will be converted on read.
- `caBundle` must be the CA that signed the webhook server's TLS certificate.

### Writing the Conversion Webhook Server

The webhook receives a `ConversionReview` containing a list of objects. The server must return each object in the requested `desiredAPIVersion`.

```go
package main

import (
	"encoding/json"
	"fmt"
	"net/http"

	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
)

func convertHandler(w http.ResponseWriter, r *http.Request) {
	var review apiextensionsv1.ConversionReview
	if err := json.NewDecoder(r.Body).Decode(&review); err != nil {
		http.Error(w, fmt.Sprintf("decode error: %v", err), http.StatusBadRequest)
		return
	}

	review.Response = convertObjects(review.Request)
	review.Response.UID = review.Request.UID

	if err := json.NewEncoder(w).Encode(review); err != nil {
		http.Error(w, fmt.Sprintf("encode error: %v", err), http.StatusInternalServerError)
	}
}

func convertObjects(req *apiextensionsv1.ConversionRequest) *apiextensionsv1.ConversionResponse {
	resp := &apiextensionsv1.ConversionResponse{}
	for _, rawObj := range req.Objects {
		cr := &unstructured.Unstructured{}
		if err := cr.UnmarshalJSON(rawObj.Raw); err != nil {
			resp.Result = metav1.Status{
				Status:  metav1.StatusFailure,
				Message: fmt.Sprintf("unmarshal: %v", err),
			}
			return resp
		}

		converted, err := convert(cr, req.DesiredAPIVersion)
		if err != nil {
			resp.Result = metav1.Status{
				Status:  metav1.StatusFailure,
				Message: fmt.Sprintf("convert %s: %v", cr.GetName(), err),
			}
			return resp
		}

		data, err := converted.MarshalJSON()
		if err != nil {
			resp.Result = metav1.Status{Status: metav1.StatusFailure, Message: err.Error()}
			return resp
		}
		resp.ConvertedObjects = append(resp.ConvertedObjects, runtime.RawExtension{Raw: data})
	}
	resp.Result = metav1.Status{Status: metav1.StatusSuccess}
	return resp
}

func convert(obj *unstructured.Unstructured, targetVersion string) (*unstructured.Unstructured, error) {
	srcVersion := obj.GetAPIVersion()
	if srcVersion == targetVersion {
		return obj.DeepCopy(), nil
	}
	out := obj.DeepCopy()
	out.SetAPIVersion(targetVersion)

	switch {
	case srcVersion == "data.example.com/v1alpha1" && targetVersion == "data.example.com/v1":
		return v1alpha1ToV1(out)
	case srcVersion == "data.example.com/v1" && targetVersion == "data.example.com/v1alpha1":
		return v1ToV1alpha1(out)
	default:
		return nil, fmt.Errorf("unsupported conversion: %s -> %s", srcVersion, targetVersion)
	}
}

func v1alpha1ToV1(obj *unstructured.Unstructured) (*unstructured.Unstructured, error) {
	storageGB, found, err := unstructured.NestedInt64(obj.Object, "spec", "storageGB")
	if err != nil || !found {
		storageGB = 20 // default
	}
	if err := unstructured.RemoveNestedField(obj.Object, "spec", "storageGB"); err != nil {
		return nil, err
	}
	if err := unstructured.SetNestedField(obj.Object, map[string]interface{}{
		"capacityGB": storageGB,
	}, "spec", "storage"); err != nil {
		return nil, err
	}
	return obj, nil
}

func v1ToV1alpha1(obj *unstructured.Unstructured) (*unstructured.Unstructured, error) {
	capacityGB, _, _ := unstructured.NestedInt64(obj.Object, "spec", "storage", "capacityGB")
	if err := unstructured.RemoveNestedField(obj.Object, "spec", "storage"); err != nil {
		return nil, err
	}
	if err := unstructured.SetNestedField(obj.Object, capacityGB, "spec", "storageGB"); err != nil {
		return nil, err
	}
	return obj, nil
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/convert", convertHandler)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	if err := http.ListenAndServeTLS(":8443", "/tls/tls.crt", "/tls/tls.key", mux); err != nil {
		panic(err)
	}
}
```

### Deploying the Conversion Webhook

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: database-webhook
  namespace: platform-system
spec:
  replicas: 2
  selector:
    matchLabels:
      app: database-webhook
  template:
    metadata:
      labels:
        app: database-webhook
    spec:
      serviceAccountName: database-webhook
      containers:
        - name: webhook
          image: registry.example.com/platform/database-webhook:v1.2.0
          args:
            - --tls-cert-file=/tls/tls.crt
            - --tls-key-file=/tls/tls.key
          ports:
            - containerPort: 8443
              name: https
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8443
              scheme: HTTPS
            initialDelaySeconds: 5
            periodSeconds: 10
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 200m
              memory: 128Mi
          volumeMounts:
            - name: tls
              mountPath: /tls
              readOnly: true
      volumes:
        - name: tls
          secret:
            secretName: database-webhook-tls
---
apiVersion: v1
kind: Service
metadata:
  name: database-webhook
  namespace: platform-system
spec:
  selector:
    app: database-webhook
  ports:
    - port: 443
      targetPort: 8443
      name: https
```

### Migrating Stored Objects

After deploying the webhook and updating the CRD to mark `v1` as the storage version, existing objects remain in etcd encoded as `v1alpha1`. A migration job forces re-encoding:

```bash
#!/usr/bin/env bash
# migrate-storage-version.sh
# Reads every Database object and writes it back, triggering etcd re-encoding at v1.
set -euo pipefail

NAMESPACE_LIST=$(kubectl get namespaces -o jsonpath='{.items[*].metadata.name}')

for ns in $NAMESPACE_LIST; do
  echo "Migrating namespace: $ns"
  for db in $(kubectl get databases -n "$ns" -o jsonpath='{.items[*].metadata.name}' 2>/dev/null); do
    echo "  Patching: $db"
    kubectl patch database "$db" -n "$ns" \
      --type=merge \
      -p '{"metadata":{"annotations":{"data.example.com/migrated":"true"}}}' \
      > /dev/null
  done
done

echo "Migration complete. Verify with:"
echo "  kubectl get databases --all-namespaces -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}: {.apiVersion}{\"\\n\"}{end}'"
```

---

## Part 2: Aggregated API Servers

### Architecture Overview

The Kubernetes API server delegates requests for unknown API groups to registered API services. An `APIService` object tells the main server: "requests for group `data.example.com`, version `v2`, should be forwarded to service `database-apiserver` in namespace `platform-system`."

The aggregated server must implement the full Kubernetes API handler contract: discovery endpoints, OpenAPI spec, and request proxying through the main server's authentication chain.

### Registering an APIService

```yaml
apiVersion: apiregistration.k8s.io/v1
kind: APIService
metadata:
  name: v2.data.example.com
spec:
  group: data.example.com
  version: v2
  groupPriorityMinimum: 2000
  versionPriority: 20
  service:
    name: database-apiserver
    namespace: platform-system
    port: 443
  caBundle: "LS0tLS1CRUd..."
  insecureSkipTLSVerify: false
```

Once the `APIService` is created, `kubectl api-resources` will show the new group. The main API server will also surface its OpenAPI schema.

### Building an Aggregated Server with apiserver-builder

The `apiserver-builder` project scaffolds the boilerplate. The resulting structure provides a full `etcd`-backed API server with built-in authentication delegation to the main cluster API server.

```bash
# Install apiserver-builder
go install sigs.k8s.io/apiserver-builder-alpha/cmd/apiserver-boot@v1.23.0

# Scaffold a new API server
mkdir -p ~/projects/database-apiserver && cd ~/projects/database-apiserver
go mod init github.com/example/database-apiserver

apiserver-boot init repo --domain data.example.com
apiserver-boot create group version resource \
  --group data \
  --version v2 \
  --kind Database

# Build and run locally against a kubeconfig
apiserver-boot run local
```

The scaffold creates a resource file. Business logic for defaulting and validation is added here:

```go
// pkg/apis/data/v2/database_types.go
package v2

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/util/validation/field"
)

// DatabaseSpec defines the desired state.
type DatabaseSpec struct {
	Engine   string          `json:"engine"`
	Storage  StorageSpec     `json:"storage"`
	Replicas int32           `json:"replicas,omitempty"`
}

// StorageSpec holds storage configuration.
type StorageSpec struct {
	CapacityGB   int64  `json:"capacityGB"`
	StorageClass string `json:"storageClass,omitempty"`
	IOPS         int64  `json:"iops,omitempty"`
}

// DatabaseStatus defines the observed state.
type DatabaseStatus struct {
	Phase      string      `json:"phase,omitempty"`
	Endpoint   string      `json:"endpoint,omitempty"`
	ReadyNodes int32       `json:"readyNodes,omitempty"`
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +genclient
// +k8s:deepcopy-gen:interfaces=k8s.io/apimachinery/pkg/runtime.Object

// Database is a managed relational database instance.
type Database struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   DatabaseSpec   `json:"spec,omitempty"`
	Status DatabaseStatus `json:"status,omitempty"`
}

// Validate is called by the API server before admission.
func (d *Database) Validate(ctx context.Context) field.ErrorList {
	var allErrs field.ErrorList
	validEngines := map[string]bool{"postgres": true, "mysql": true}
	if !validEngines[d.Spec.Engine] {
		allErrs = append(allErrs, field.NotSupported(
			field.NewPath("spec", "engine"),
			d.Spec.Engine,
			[]string{"postgres", "mysql"},
		))
	}
	if d.Spec.Storage.CapacityGB < 10 {
		allErrs = append(allErrs, field.Invalid(
			field.NewPath("spec", "storage", "capacityGB"),
			d.Spec.Storage.CapacityGB,
			"must be at least 10 GB",
		))
	}
	return allErrs
}

// Default sets missing fields.
func (d *Database) Default() {
	if d.Spec.Replicas == 0 {
		d.Spec.Replicas = 1
	}
	if d.Spec.Storage.StorageClass == "" {
		d.Spec.Storage.StorageClass = "standard"
	}
}

// +k8s:deepcopy-gen:interfaces=k8s.io/apimachinery/pkg/runtime.Object

// DatabaseList contains a list of Database.
type DatabaseList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []Database `json:"items"`
}

func init() {
	SchemeBuilder.Register(&Database{}, &DatabaseList{})
}
```

### Authentication Delegation

The aggregated server must trust the main API server as an authenticator. This is done by configuring the server with `--authentication-kubeconfig` and `--authorization-kubeconfig` pointing to a kubeconfig that has access to `TokenReview` and `SubjectAccessReview`.

```yaml
# kube-rbac-proxy sidecar configuration for the aggregated server
containers:
  - name: kube-rbac-proxy
    image: gcr.io/kubebuilder/kube-rbac-proxy:v0.15.0
    args:
      - --secure-listen-address=0.0.0.0:8443
      - --upstream=http://127.0.0.1:8080/
      - --logtostderr=true
      - --v=0
    ports:
      - containerPort: 8443
        name: https
  - name: database-apiserver
    image: registry.example.com/platform/database-apiserver:v2.0.0
    args:
      - --etcd-servers=https://etcd.platform-system.svc:2379
      - --etcd-cafile=/etcd-tls/ca.crt
      - --etcd-certfile=/etcd-tls/tls.crt
      - --etcd-keyfile=/etcd-tls/tls.key
      - --authentication-kubeconfig=/kubeconfig/config
      - --authorization-kubeconfig=/kubeconfig/config
      - --tls-cert-file=/tls/tls.crt
      - --tls-private-key-file=/tls/tls.key
      - --bind-address=127.0.0.1
      - --secure-port=8080
```

---

## Operational Considerations

### Monitoring Webhook Availability

A failed conversion webhook causes ALL reads of affected objects to return 500 errors. Alert on webhook availability with high urgency:

```yaml
groups:
  - name: api-extensions
    rules:
      - alert: CRDConversionWebhookDown
        expr: |
          absent(up{job="database-webhook"}) == 1
          or
          up{job="database-webhook"} == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "CRD conversion webhook is unreachable"
          description: "The database-webhook service in platform-system is not responding. All reads of Database objects will fail."

      - alert: AggregatedAPIServerDown
        expr: |
          apiserver_registered_watchers{group="data.example.com"} == 0
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Aggregated API server has no registered watchers"
```

### PodDisruptionBudget for Webhooks

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: database-webhook-pdb
  namespace: platform-system
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: database-webhook
```

### Fallback Policy During Outages

Configure `failurePolicy: Fail` on conversion webhooks to prevent silent data corruption, and ensure that the webhook deployment has `topologySpreadConstraints` across availability zones:

```yaml
topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: topology.kubernetes.io/zone
    whenUnsatisfiable: DoNotSchedule
    labelSelector:
      matchLabels:
        app: database-webhook
```

---

## Testing Conversion Correctness

### Unit Test for Conversion Logic

```go
package main_test

import (
	"encoding/json"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func TestV1alpha1ToV1Conversion(t *testing.T) {
	src := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "data.example.com/v1alpha1",
			"kind":       "Database",
			"metadata":   map[string]interface{}{"name": "pg-primary", "namespace": "production"},
			"spec": map[string]interface{}{
				"engine":    "postgres",
				"storageGB": int64(50),
			},
		},
	}

	converted, err := convert(src, "data.example.com/v1")
	if err != nil {
		t.Fatalf("convert: %v", err)
	}

	capacityGB, found, err := unstructured.NestedInt64(converted.Object, "spec", "storage", "capacityGB")
	if err != nil || !found {
		t.Fatalf("spec.storage.capacityGB not found after conversion")
	}
	if capacityGB != 50 {
		t.Errorf("expected capacityGB=50, got %d", capacityGB)
	}

	_, oldFound, _ := unstructured.NestedInt64(converted.Object, "spec", "storageGB")
	if oldFound {
		t.Error("spec.storageGB should have been removed after conversion to v1")
	}

	if converted.GetAPIVersion() != "data.example.com/v1" {
		t.Errorf("wrong apiVersion: %s", converted.GetAPIVersion())
	}
}

func TestRoundTripConversion(t *testing.T) {
	original := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "data.example.com/v1",
			"kind":       "Database",
			"metadata":   map[string]interface{}{"name": "pg-replica", "namespace": "production"},
			"spec": map[string]interface{}{
				"engine": "postgres",
				"storage": map[string]interface{}{
					"capacityGB":   int64(100),
					"storageClass": "premium-ssd",
				},
			},
		},
	}

	downgraded, err := convert(original, "data.example.com/v1alpha1")
	if err != nil {
		t.Fatalf("downgrade: %v", err)
	}
	upgraded, err := convert(downgraded, "data.example.com/v1")
	if err != nil {
		t.Fatalf("upgrade: %v", err)
	}

	origJSON, _ := json.Marshal(original.Object["spec"])
	upgJSON, _ := json.Marshal(upgraded.Object["spec"])

	// Note: storageClass is lost in v1alpha1 round-trip — document this lossiness.
	capacityOrig, _, _ := unstructured.NestedInt64(original.Object, "spec", "storage", "capacityGB")
	capacityFinal, _, _ := unstructured.NestedInt64(upgraded.Object, "spec", "storage", "capacityGB")
	if capacityOrig != capacityFinal {
		t.Errorf("capacity mismatch after round-trip: orig=%d final=%d\norig spec: %s\nfinal spec: %s",
			capacityOrig, capacityFinal, origJSON, upgJSON)
	}
}
```

---

## Summary

| Mechanism | When to Use | Complexity | Failure Impact |
|-----------|-------------|------------|----------------|
| CRD + no conversion | Single version, stable schema | Low | None |
| CRD + conversion webhook | Multi-version CRD evolution | Medium | All reads fail if webhook is down |
| Aggregated API server | Custom admission, sub-resources, tight storage coupling | High | API group unavailable if server is down |

Kubernetes API extensions are powerful but carry operational weight. The conversion webhook must be treated as a critical infrastructure component: deploy it with redundancy, monitor it with alerting, and test every conversion path with round-trip unit tests before promoting to production. Aggregated API servers offer more control at the cost of managing a complete API server implementation, including its own etcd connection and TLS chain.

Both mechanisms enable platform teams to present domain-specific APIs through the native Kubernetes API machinery, with the full benefits of RBAC, audit logging, and tooling compatibility.
