---
title: "Load Testing Go APIs: k6, Locust, and vegeta Patterns"
date: 2028-12-05T00:00:00-05:00
draft: false
tags: ["Go", "Load Testing", "Performance", "k6", "vegeta"]
categories:
- Go
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive load testing guide for Go APIs using vegeta for Go-native testing, k6 for complex scenario scripting, Locust for user-behavior simulation, and k6 Operator for Kubernetes-native distributed load generation."
more_link: "yes"
url: "/go-load-testing-k6-locust-vegeta-guide/"
---

Load testing is the empirical verification that a system behaves predictably under the traffic patterns it will actually encounter. The three tools covered here serve different purposes: vegeta is a Go library and CLI for constant-rate HTTP load generation with rich histogram output; k6 is a scriptable JavaScript tool for complex multi-step user flows with built-in metrics; and Locust is a Python framework for simulating diverse user behavior at scale. Each has a distinct place in a performance engineering workflow.

This guide covers writing effective test scripts for a CRUD API in each tool, interpreting results, running distributed tests in Kubernetes with k6 Operator, and correlating test results with production behavior.

<!--more-->

# Load Testing Go APIs: k6, Locust, and vegeta

## Section 1: The Target API

All examples test a simple order management REST API:

```
POST   /orders            Create order
GET    /orders/:id        Get order
PUT    /orders/:id/items  Add item to order
PATCH  /orders/:id/confirm Confirm order
GET    /orders?customer=X  List customer orders
```

The API server for reference:

```go
// cmd/api/main.go
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/google/uuid"
)

type Order struct {
	ID         string    `json:"id"`
	CustomerID string    `json:"customer_id"`
	Status     string    `json:"status"`
	CreatedAt  time.Time `json:"created_at"`
}

var orders = map[string]*Order{}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /orders", createOrder)
	mux.HandleFunc("GET /orders/{id}", getOrder)
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	})
	log.Fatal(http.ListenAndServe(":8080", mux))
}

func createOrder(w http.ResponseWriter, r *http.Request) {
	var req struct {
		CustomerID string `json:"customer_id"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	o := &Order{
		ID:         uuid.New().String(),
		CustomerID: req.CustomerID,
		Status:     "draft",
		CreatedAt:  time.Now(),
	}
	orders[o.ID] = o
	// Simulate processing time: p50=10ms, p99=100ms
	time.Sleep(time.Duration(10+len(orders)) * time.Millisecond)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(o)
}

func getOrder(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	o, ok := orders[id]
	if !ok {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(o)
}
```

## Section 2: vegeta — Go-Native Constant-Rate Load Testing

vegeta shines for constant-rate testing where you want to control requests-per-second precisely. It also works as an importable Go library, making it easy to embed load tests in the same repository as the service under test.

### CLI usage

```bash
# Install
go install github.com/tsenart/vegeta@latest

# Create a targets file
cat > targets.txt << 'EOF'
POST http://localhost:8080/orders
Content-Type: application/json
@order-body.json

GET http://localhost:8080/orders/00000000-0000-0000-0000-000000000001
EOF

cat > order-body.json << 'EOF'
{"customer_id": "cust-abc"}
EOF

# Run at 200 req/s for 30 seconds
vegeta attack -targets=targets.txt -rate=200 -duration=30s | \
  vegeta report

# Output:
# Requests      [total, rate, throughput]  6000, 200.03, 198.22/s
# Duration      [total, attack, wait]      30.28s, 29.995s, 289ms
# Latencies     [min, mean, 50, 90, 95, 99, max]  8.2ms, 22.4ms, 15ms, 45ms, 68ms, 142ms, 890ms
# Bytes In      [total, mean]              492000, 82
# Bytes Out     [total, mean]              174000, 29
# Success       [ratio]                    99.70%
# Status Codes  [code:count]               201:5982  429:18
# Error Set:
# 429 Too Many Requests

# Generate an HDR histogram
vegeta attack -targets=targets.txt -rate=200 -duration=30s | \
  vegeta report -type=hdrplot > latency.hdr

# Generate JSON for further processing
vegeta attack -targets=targets.txt -rate=200 -duration=30s | \
  vegeta report -type=json | jq '.latencies | {p50: .p50, p95: .p95, p99: .p99, max: .max}'
```

### vegeta as a Go library

Embedding load tests in Go gives you type-safe parameter injection, access to internal metrics, and CI-native assertions:

```go
// loadtest/vegeta_test.go
package loadtest_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	vegeta "github.com/tsenart/vegeta/v12/lib"
)

func TestOrderCreationLoad(t *testing.T) {
	rate := vegeta.Rate{Freq: 100, Per: time.Second}
	duration := 20 * time.Second

	targeter := func(target *vegeta.Target) error {
		body, _ := json.Marshal(map[string]string{
			"customer_id": "cust-" + time.Now().Format("150405.000"),
		})
		target.Method = http.MethodPost
		target.URL = "http://localhost:8080/orders"
		target.Header = http.Header{
			"Content-Type": []string{"application/json"},
		}
		target.Body = body
		return nil
	}

	attacker := vegeta.NewAttacker(
		vegeta.Timeout(5*time.Second),
		vegeta.Connections(100),
		vegeta.Workers(50),
	)

	var metrics vegeta.Metrics
	for res := range attacker.Attack(targeter, rate, duration, "Order Creation") {
		metrics.Add(res)
	}
	metrics.Close()

	t.Logf("Requests:  total=%d rate=%.1f/s", metrics.Requests, metrics.Rate)
	t.Logf("Latencies: p50=%v p95=%v p99=%v max=%v",
		metrics.Latencies.P50, metrics.Latencies.P95,
		metrics.Latencies.P99, metrics.Latencies.Max,
	)
	t.Logf("Success:   %.2f%%", metrics.Success*100)

	// Assertions
	if metrics.Success < 0.999 {
		t.Errorf("success rate %.2f%% below 99.9%% threshold", metrics.Success*100)
	}
	if metrics.Latencies.P99 > 200*time.Millisecond {
		t.Errorf("p99 latency %v exceeds 200ms SLO", metrics.Latencies.P99)
	}
	if metrics.Latencies.P50 > 50*time.Millisecond {
		t.Errorf("p50 latency %v exceeds 50ms target", metrics.Latencies.P50)
	}
}

func TestRampUp(t *testing.T) {
	// Pacer that ramps from 10 to 200 req/s over 60 seconds
	pacer := vegeta.LinearPacer{
		StartAt: vegeta.Rate{Freq: 10, Per: time.Second},
		Slope:   3.17, // 190 rps / 60 s
	}
	duration := 60 * time.Second
	body := []byte(`{"customer_id":"cust-ramp"}`)

	targeter := vegeta.NewStaticTargeter(vegeta.Target{
		Method: "POST",
		URL:    "http://localhost:8080/orders",
		Header: http.Header{"Content-Type": []string{"application/json"}},
		Body:   body,
	})

	attacker := vegeta.NewAttacker()
	var metrics vegeta.Metrics
	for res := range attacker.Attack(targeter, pacer, duration, "Ramp Up") {
		metrics.Add(res)
	}
	metrics.Close()

	// Print latency histogram
	hist := &vegeta.Histogram{Buckets: vegeta.DefaultBuckets}
	for _, bucket := range hist.Buckets {
		t.Logf("bucket <%v: count not available in this API version", bucket)
	}

	t.Logf("Final rate: %.1f req/s, p99: %v", metrics.Rate, metrics.Latencies.P99)
}
```

```bash
go test ./loadtest/... -v -run TestOrderCreationLoad -tags load
```

## Section 3: k6 — Scriptable Scenario Load Testing

k6 uses JavaScript for test scripts. It is the best choice for multi-step user flows that involve reading values from responses (e.g., create an order, then get its ID, then confirm it).

### Installation

```bash
# Linux
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6
```

### Realistic CRUD scenario

```javascript
// k6/order-flow.js
import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';
import { randomString } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

// Custom metrics
const orderCreationErrors = new Rate('order_creation_errors');
const orderFlowDuration = new Trend('order_flow_duration_ms', true);
const confirmedOrders = new Counter('confirmed_orders');

// Load profile: ramp up, sustain, ramp down
export const options = {
  stages: [
    { duration: '30s', target: 10 },   // warm-up
    { duration: '2m',  target: 50 },   // ramp to 50 VUs
    { duration: '5m',  target: 50 },   // sustain
    { duration: '30s', target: 100 },  // spike
    { duration: '1m',  target: 100 },  // sustain spike
    { duration: '30s', target: 0 },    // ramp down
  ],
  thresholds: {
    // SLO: 99% of requests complete in under 500ms
    http_req_duration: ['p(99)<500'],
    // SLO: error rate under 0.1%
    http_req_failed: ['rate<0.001'],
    // Custom: order creation errors under 0.5%
    order_creation_errors: ['rate<0.005'],
    // Custom: full order flow p95 under 1 second
    order_flow_duration_ms: ['p(95)<1000'],
  },
  ext: {
    loadimpact: {
      projectID: 3478910,
      name: 'Order API Load Test',
    },
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';

function createOrder(customerID) {
  const payload = JSON.stringify({ customer_id: customerID });
  const params = {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'CreateOrder' },
  };
  const res = http.post(`${BASE_URL}/orders`, payload, params);
  const success = check(res, {
    'create: status 201':     (r) => r.status === 201,
    'create: has order_id':   (r) => r.json('id') !== undefined,
    'create: latency < 300ms': (r) => r.timings.duration < 300,
  });
  orderCreationErrors.add(!success);
  return res.json('id');
}

function getOrder(orderID) {
  const params = { tags: { name: 'GetOrder' } };
  const res = http.get(`${BASE_URL}/orders/${orderID}`, params);
  check(res, {
    'get: status 200':       (r) => r.status === 200,
    'get: correct id':       (r) => r.json('id') === orderID,
    'get: latency < 100ms':  (r) => r.timings.duration < 100,
  });
  return res;
}

function confirmOrder(orderID) {
  const params = {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'ConfirmOrder' },
  };
  const res = http.patch(`${BASE_URL}/orders/${orderID}/confirm`, '{}', params);
  check(res, {
    'confirm: status 200': (r) => r.status === 200,
  });
  return res;
}

export default function () {
  const customerID = `cust-${randomString(8)}`;
  const flowStart = Date.now();

  group('Full Order Workflow', () => {
    // Step 1: Create order
    const orderID = createOrder(customerID);
    if (!orderID) {
      return; // abort if creation failed
    }

    sleep(0.1); // think time between steps

    // Step 2: Read it back
    getOrder(orderID);

    sleep(0.1);

    // Step 3: Confirm
    const confirmRes = confirmOrder(orderID);
    if (confirmRes.status === 200) {
      confirmedOrders.add(1);
    }
  });

  orderFlowDuration.add(Date.now() - flowStart);
  sleep(Math.random() * 2 + 0.5); // 0.5 - 2.5s think time
}

export function handleSummary(data) {
  return {
    'stdout': textSummary(data, { indent: ' ', enableColors: true }),
    'results/summary.json': JSON.stringify(data, null, 2),
  };
}

function textSummary(data, opts) {
  // Simple text summary (replace with k6-reporter for HTML output)
  const metrics = data.metrics;
  return `
=== Load Test Summary ===
Requests:    ${metrics.http_reqs.values.count}
Rate:        ${metrics.http_reqs.values.rate.toFixed(1)} req/s
Duration:    ${(data.state.testRunDurationMs / 1000).toFixed(1)}s

Latency:
  p50:  ${metrics.http_req_duration.values['p(50)'].toFixed(1)}ms
  p90:  ${metrics.http_req_duration.values['p(90)'].toFixed(1)}ms
  p95:  ${metrics.http_req_duration.values['p(95)'].toFixed(1)}ms
  p99:  ${metrics.http_req_duration.values['p(99)'].toFixed(1)}ms
  max:  ${metrics.http_req_duration.values.max.toFixed(1)}ms

Error Rate: ${(metrics.http_req_failed.values.rate * 100).toFixed(3)}%
Confirmed Orders: ${metrics.confirmed_orders?.values.count || 0}
`;
}
```

```bash
# Run the test
k6 run k6/order-flow.js

# Run with environment override
k6 run -e BASE_URL=http://staging.example.com k6/order-flow.js

# Run with HTML report (requires xk6-reporter)
K6_WEB_DASHBOARD=true k6 run k6/order-flow.js
```

## Section 4: Locust — User-Behavior Simulation

Locust models users as Python objects with `wait_time` between tasks, making it natural for simulating realistic user sessions.

```python
# locustfile.py
import json
import random
from locust import HttpUser, between, task, tag
from locust.exception import RescheduleTask


class OrderUser(HttpUser):
    """Simulates a user who browses, creates, and manages orders."""
    wait_time = between(0.5, 2.0)

    def on_start(self):
        """Called when a user starts. Create a customer ID for this session."""
        self.customer_id = f"cust-{random.randint(100000, 999999)}"
        self.active_order_ids = []

    @task(3)
    @tag("read")
    def list_orders(self):
        """Frequent read operation: list orders for this customer."""
        with self.client.get(
            f"/orders?customer={self.customer_id}",
            name="/orders?customer=[id]",
            catch_response=True,
        ) as response:
            if response.status_code == 200:
                try:
                    data = response.json()
                    response.success()
                except json.JSONDecodeError:
                    response.failure("Invalid JSON in list response")
            else:
                response.failure(f"Unexpected status: {response.status_code}")

    @task(2)
    @tag("write")
    def create_order(self):
        """Create a new draft order."""
        payload = {"customer_id": self.customer_id}
        with self.client.post(
            "/orders",
            json=payload,
            name="POST /orders",
            catch_response=True,
        ) as response:
            if response.status_code == 201:
                try:
                    order = response.json()
                    self.active_order_ids.append(order["id"])
                    response.success()
                except (json.JSONDecodeError, KeyError):
                    response.failure("Bad create response")
            else:
                response.failure(f"Create failed: {response.status_code}")

    @task(2)
    @tag("read")
    def get_order(self):
        """Read a specific order (requires at least one to exist)."""
        if not self.active_order_ids:
            raise RescheduleTask()
        order_id = random.choice(self.active_order_ids)
        with self.client.get(
            f"/orders/{order_id}",
            name="GET /orders/[id]",
            catch_response=True,
        ) as response:
            if response.status_code == 200:
                response.success()
            elif response.status_code == 404:
                # Order may have been deleted; remove from local list
                self.active_order_ids.remove(order_id)
                response.success()  # 404 is expected, not a failure
            else:
                response.failure(f"Get failed: {response.status_code}")

    @task(1)
    @tag("write")
    def confirm_order(self):
        """Confirm a draft order (low frequency)."""
        if not self.active_order_ids:
            raise RescheduleTask()
        order_id = self.active_order_ids.pop(0)  # confirm oldest order
        with self.client.patch(
            f"/orders/{order_id}/confirm",
            json={},
            name="PATCH /orders/[id]/confirm",
            catch_response=True,
        ) as response:
            if response.status_code in (200, 409):
                response.success()
            else:
                response.failure(f"Confirm failed: {response.status_code}")


class HeavyReader(HttpUser):
    """Represents a reporting service that reads many orders."""
    wait_time = between(0.1, 0.5)
    weight = 3  # 3x more of these than OrderUser

    @task
    def fetch_recent_orders(self):
        for cust_id in [f"cust-{i}" for i in random.sample(range(1, 100), 5)]:
            self.client.get(
                f"/orders?customer={cust_id}",
                name="/orders?customer=[id]",
            )
```

```bash
# Run headless Locust test
locust \
  --headless \
  --users 100 \
  --spawn-rate 5 \
  --run-time 5m \
  --host http://localhost:8080 \
  --html results/report.html \
  --csv results/locust \
  -f locustfile.py

# Check results
cat results/locust_stats.csv
```

## Section 5: k6 Operator — Distributed Load in Kubernetes

Running load tests in Kubernetes allows generating traffic closer to production topology and using cluster resources for large-scale tests.

```bash
# Install k6 Operator
helm repo add grafana https://grafana.github.io/helm-charts
helm install k6-operator grafana/k6-operator --namespace k6-operator --create-namespace
```

```yaml
# k8s/k6-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: order-load-test
  namespace: testing
data:
  order-flow.js: |
    import http from 'k6/http';
    import { check, sleep } from 'k6';

    export const options = {
      scenarios: {
        order_creation: {
          executor: 'ramping-arrival-rate',
          startRate: 10,
          timeUnit: '1s',
          preAllocatedVUs: 50,
          maxVUs: 200,
          stages: [
            { target: 50,  duration: '1m' },
            { target: 100, duration: '3m' },
            { target: 50,  duration: '1m' },
            { target: 0,   duration: '30s' },
          ],
        },
      },
      thresholds: {
        http_req_duration: ['p(99)<500'],
        http_req_failed: ['rate<0.01'],
      },
    };

    const BASE_URL = __ENV.BASE_URL || 'http://order-api.production.svc.cluster.local';

    export default function () {
      const res = http.post(`${BASE_URL}/orders`, JSON.stringify({
        customer_id: `cust-${Math.random().toString(36).slice(2, 10)}`,
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
      check(res, { 'status 201': (r) => r.status === 201 });
      sleep(0.5);
    }
---
apiVersion: k6.io/v1alpha1
kind: TestRun
metadata:
  name: order-api-load-test
  namespace: testing
spec:
  parallelism: 4   # 4 k6 runner pods
  script:
    configMap:
      name: order-load-test
      file: order-flow.js
  arguments: "--out prometheus=server=http://prometheus-server.monitoring:9090/api/v1/write"
  runner:
    env:
      - name: BASE_URL
        value: http://order-api.production.svc.cluster.local
    resources:
      requests:
        cpu: "500m"
        memory: "256Mi"
      limits:
        cpu: "2"
        memory: "512Mi"
```

```bash
kubectl apply -f k8s/k6-configmap.yaml

# Watch the test run
kubectl get testrun -n testing -w
kubectl logs -n testing -l k6_cr=order-api-load-test -f

# Check k6 metrics in Prometheus
kubectl port-forward -n monitoring svc/prometheus-server 9090:9090
# Query: k6_http_req_duration_p99
```

## Section 6: Interpreting Results and Correlating with Production

### Latency percentile analysis

```bash
# vegeta JSON output analysis
vegeta attack -targets=targets.txt -rate=200 -duration=60s | \
  vegeta report -type=json > results.json

# Parse with jq
jq '{
  rate: .rate,
  success: .success,
  p50_ms: (.latencies.p50 / 1000000),
  p95_ms: (.latencies.p95 / 1000000),
  p99_ms: (.latencies.p99 / 1000000),
  max_ms: (.latencies.max / 1000000),
  requests: .requests
}' results.json
```

### Correlate with Prometheus/Grafana

```promql
# Match load test rate with observed server-side rate
rate(http_requests_total{job="order-api"}[1m])

# Compare load test p99 with server-side p99
histogram_quantile(0.99, rate(http_request_duration_seconds_bucket{job="order-api"}[5m]))

# Observe Go GC pressure during load test
go_gc_duration_seconds{quantile="0.99"}

# Goroutine count growth under load (leading indicator of goroutine leak)
go_goroutines{job="order-api"}

# Database connection pool saturation
db_pool_wait_duration_seconds_sum / db_pool_wait_duration_seconds_count
```

### Load test vs production comparison matrix

| Metric | Load Test (200 rps) | Production (150 rps avg) | Status |
|--------|--------------------|-----------------------|--------|
| p50 latency | 15ms | 12ms | Good |
| p99 latency | 142ms | 110ms | Acceptable |
| Error rate | 0.30% | 0.05% | Investigate |
| GC pause p99 | 8ms | 3ms | Good |
| Goroutines | 450 | 380 | Good |

The higher error rate at 200 rps vs 150 rps suggests a connection pool bottleneck at around 180 rps. Investigate with:

```go
// Add pool metrics to the API server
import "database/sql"

func registerDBMetrics(db *sql.DB) {
    go func() {
        for range time.Tick(5 * time.Second) {
            stats := db.Stats()
            dbOpenConnections.Set(float64(stats.OpenConnections))
            dbInUse.Set(float64(stats.InUse))
            dbIdle.Set(float64(stats.Idle))
            dbWaitCount.Add(float64(stats.WaitCount))
            dbWaitDuration.Observe(stats.WaitDuration.Seconds())
        }
    }()
}
```

Load testing is only useful if results are acted on. The workflow is: establish a baseline, identify the limiting factor (CPU, memory, connections, locks, network), fix it, and re-test to verify improvement. Automate the test suite so performance regressions are caught in CI before reaching production.
