---
title: "GitOps Progressive Delivery with Argo Rollouts: Canary and Blue-Green at Scale"
date: 2028-02-27T00:00:00-05:00
draft: false
tags: ["ArgoCD", "Argo Rollouts", "GitOps", "Canary", "Blue-Green", "Progressive Delivery", "Istio"]
categories: ["Kubernetes", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete guide to progressive delivery with Argo Rollouts: canary deployments with Prometheus analysis, blue-green with preview services, Istio/NGINX traffic shifting, automated rollback, and full Argo CD GitOps integration."
more_link: "yes"
url: "/gitops-progressive-delivery-argo-rollouts-guide/"
---

Progressive delivery reduces deployment risk by gradually shifting traffic from stable to canary releases while continuously evaluating metrics. Argo Rollouts implements this at the Kubernetes level, providing canary and blue-green strategies with native integration for Prometheus, Istio, NGINX, and automated analysis. Combined with Argo CD for GitOps-driven lifecycle management, progressive delivery becomes reproducible, auditable, and fully automated. This guide covers every major Argo Rollouts capability from initial installation to production-grade automated deployments with rollback.

<!--more-->

## Argo Rollouts Architecture

Argo Rollouts replaces the standard Kubernetes Deployment controller with an enhanced `Rollout` resource that understands traffic routing and metric analysis. The controller watches `Rollout` objects and orchestrates:

- `ReplicaSet` management (similar to Deployment)
- Traffic weighting via `AnalysisTemplate` and service mesh integration
- `AnalysisRun` execution for metric-based promotion gates
- Automatic rollback when analysis fails

### Installation

```bash
kubectl create namespace argo-rollouts

kubectl apply -n argo-rollouts \
  -f https://github.com/argoproj/argo-rollouts/releases/latest/download/install.yaml

# Install the kubectl plugin
curl -LO https://github.com/argoproj/argo-rollouts/releases/latest/download/kubectl-argo-rollouts-linux-amd64
chmod +x kubectl-argo-rollouts-linux-amd64
sudo mv kubectl-argo-rollouts-linux-amd64 /usr/local/bin/kubectl-argo-rollouts

# Verify
kubectl argo rollouts version
```

## Canary Deployment with Prometheus Analysis

The canonical production pattern: deploy the new version to a small percentage of traffic, evaluate metrics, and promote in steps if metrics pass.

### AnalysisTemplate for HTTP Error Rate

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: http-error-rate
  namespace: production
spec:
  args:
  - name: service-name
  - name: namespace
    value: production
  metrics:
  - name: http-error-rate
    interval: 1m
    # Fail immediately if error rate exceeds 5%
    failureCondition: result[0] > 0.05
    # Allow up to 2 consecutive failures before failing the analysis
    failureLimit: 2
    count: 5
    provider:
      prometheus:
        address: http://prometheus-operated.monitoring.svc.cluster.local:9090
        query: >-
          sum(rate(http_requests_total{
            service="{{args.service-name}}",
            namespace="{{args.namespace}}",
            status=~"5.."
          }[5m]))
          /
          sum(rate(http_requests_total{
            service="{{args.service-name}}",
            namespace="{{args.namespace}}"
          }[5m]))

  - name: p99-latency
    interval: 1m
    failureCondition: result[0] > 0.5
    failureLimit: 2
    count: 5
    provider:
      prometheus:
        address: http://prometheus-operated.monitoring.svc.cluster.local:9090
        query: >-
          histogram_quantile(0.99,
            sum(rate(http_request_duration_seconds_bucket{
              service="{{args.service-name}}",
              namespace="{{args.namespace}}"
            }[5m]))
            by (le)
          )
```

### Canary Rollout with Stepwise Promotion

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: api-server
  namespace: production
spec:
  replicas: 20
  selector:
    matchLabels:
      app: api-server
  template:
    metadata:
      labels:
        app: api-server
    spec:
      containers:
      - name: api-server
        image: registry.example.com/api-server:v2.1.0
        ports:
        - containerPort: 8080
        resources:
          requests:
            cpu: "250m"
            memory: "256Mi"
          limits:
            cpu: "1"
            memory: "512Mi"
        readinessProbe:
          httpGet:
            path: /ready
            port: 8080
          initialDelaySeconds: 10
          periodSeconds: 5
  strategy:
    canary:
      canaryService: api-server-canary
      stableService: api-server-stable
      maxSurge: "20%"
      maxUnavailable: 0
      analysis:
        templates:
        - templateName: http-error-rate
        startingStep: 2  # Start analysis at step 2
        args:
        - name: service-name
          value: api-server-canary
      steps:
      # Step 1: 5% traffic, wait 2 minutes for initial signal
      - setWeight: 5
      - pause:
          duration: 2m

      # Step 2: 20% traffic, run analysis
      - setWeight: 20
      - pause:
          duration: 5m

      # Step 3: 40% traffic, analysis continues
      - setWeight: 40
      - pause:
          duration: 5m

      # Step 4: Manual approval gate (pause without duration)
      - setWeight: 60
      - pause: {}

      # Step 5: Final ramp up
      - setWeight: 80
      - pause:
          duration: 2m
```

### Services for Canary Traffic Splitting

```yaml
# Stable service: receives traffic from non-canary replicas
apiVersion: v1
kind: Service
metadata:
  name: api-server-stable
  namespace: production
spec:
  selector:
    app: api-server
  ports:
  - port: 80
    targetPort: 8080
---
# Canary service: receives traffic from canary replicas
apiVersion: v1
kind: Service
metadata:
  name: api-server-canary
  namespace: production
spec:
  selector:
    app: api-server
  ports:
  - port: 80
    targetPort: 8080
---
# Main ingress service (routes to stable by default)
apiVersion: v1
kind: Service
metadata:
  name: api-server
  namespace: production
spec:
  selector:
    app: api-server
  ports:
  - port: 80
    targetPort: 8080
```

## Traffic Shifting with NGINX Ingress

NGINX Ingress implements canary weight by routing a percentage of requests to the canary service using annotations.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: api-server-nginx
  namespace: production
spec:
  replicas: 10
  selector:
    matchLabels:
      app: api-server
  template:
    metadata:
      labels:
        app: api-server
    spec:
      containers:
      - name: api-server
        image: registry.example.com/api-server:v2.1.0
        ports:
        - containerPort: 8080
  strategy:
    canary:
      canaryService: api-server-canary
      stableService: api-server-stable
      trafficRouting:
        nginx:
          stableIngress: api-server-ingress
          additionalIngressAnnotations:
            canary-by-header: X-Canary
            canary-by-header-value: "true"
      steps:
      - setWeight: 10
      - pause:
          duration: 5m
      - setWeight: 30
      - pause:
          duration: 5m
      - setWeight: 50
      - pause: {}
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-server-ingress
  namespace: production
  annotations:
    kubernetes.io/ingress.class: nginx
spec:
  rules:
  - host: api.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: api-server-stable
            port:
              number: 80
```

Argo Rollouts automatically creates and updates a second canary Ingress with `nginx.ingress.kubernetes.io/canary: "true"` and `nginx.ingress.kubernetes.io/canary-weight` annotations.

## Traffic Shifting with Istio VirtualService

Istio provides precise header-based and percentage-based routing through VirtualService weight fields.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: api-server-istio
  namespace: production
spec:
  replicas: 10
  selector:
    matchLabels:
      app: api-server
  template:
    metadata:
      labels:
        app: api-server
    spec:
      containers:
      - name: api-server
        image: registry.example.com/api-server:v2.1.0
        ports:
        - containerPort: 8080
  strategy:
    canary:
      canaryService: api-server-canary
      stableService: api-server-stable
      trafficRouting:
        istio:
          virtualService:
            name: api-server-vsvc
            routes:
            - primary
      steps:
      - setWeight: 5
      - pause:
          duration: 2m
      - setWeight: 20
      - pause:
          duration: 5m
      - setWeight: 50
      - pause: {}
---
apiVersion: networking.istio.io/v1alpha3
kind: VirtualService
metadata:
  name: api-server-vsvc
  namespace: production
spec:
  gateways:
  - istio-system/main-gateway
  hosts:
  - api.example.com
  http:
  - name: primary
    route:
    - destination:
        host: api-server-stable
        port:
          number: 80
      weight: 100
    - destination:
        host: api-server-canary
        port:
          number: 80
      weight: 0
```

Argo Rollouts updates the `weight` fields in the VirtualService `route` entries as the canary progresses through steps.

### Header-Based Routing for Testing

```yaml
apiVersion: networking.istio.io/v1alpha3
kind: VirtualService
metadata:
  name: api-server-vsvc
  namespace: production
spec:
  hosts:
  - api.example.com
  http:
  # Always route to canary if X-Canary-Version header is present
  - match:
    - headers:
        x-canary-version:
          exact: "v2.1.0"
    route:
    - destination:
        host: api-server-canary
        port:
          number: 80
  # Default: managed by Argo Rollouts
  - name: primary
    route:
    - destination:
        host: api-server-stable
        port:
          number: 80
      weight: 100
    - destination:
        host: api-server-canary
        port:
          number: 80
      weight: 0
```

This enables QA teams to test the canary with explicit headers while normal users remain on stable.

## Blue-Green Deployment with Preview Service

Blue-green maintains two complete environments. The preview service receives traffic for testing before the active service is switched.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: api-server-bg
  namespace: production
spec:
  replicas: 10
  selector:
    matchLabels:
      app: api-server
  template:
    metadata:
      labels:
        app: api-server
    spec:
      containers:
      - name: api-server
        image: registry.example.com/api-server:v2.1.0
        ports:
        - containerPort: 8080
  strategy:
    blueGreen:
      activeService: api-server-active
      previewService: api-server-preview
      # Wait this long before auto-promoting after analysis passes
      autoPromotionEnabled: false
      # Scale up preview to this count before switching
      previewReplicaCount: 3
      # Run analysis on preview traffic before promotion
      prePromotionAnalysis:
        templates:
        - templateName: http-error-rate
        args:
        - name: service-name
          value: api-server-preview
      # Run analysis after promotion to verify active traffic
      postPromotionAnalysis:
        templates:
        - templateName: http-error-rate
        args:
        - name: service-name
          value: api-server-active
      # Keep old ReplicaSet for this long after promotion (for rollback)
      scaleDownDelaySeconds: 600
---
apiVersion: v1
kind: Service
metadata:
  name: api-server-active
  namespace: production
spec:
  selector:
    app: api-server
  ports:
  - port: 80
    targetPort: 8080
---
apiVersion: v1
kind: Service
metadata:
  name: api-server-preview
  namespace: production
spec:
  selector:
    app: api-server
  ports:
  - port: 80
    targetPort: 8080
```

### Blue-Green Promotion Workflow

```bash
# Check current rollout status
kubectl argo rollouts status api-server-bg -n production

# Get detailed status with replica sets and analysis
kubectl argo rollouts get rollout api-server-bg -n production --watch

# Update image to trigger rollout
kubectl argo rollouts set image api-server-bg \
  api-server=registry.example.com/api-server:v2.2.0 \
  -n production

# Watch status (shows blue = stable, green = preview)
kubectl argo rollouts get rollout api-server-bg -n production --watch

# Manually promote (when autoPromotionEnabled=false)
kubectl argo rollouts promote api-server-bg -n production

# Abort and rollback
kubectl argo rollouts abort api-server-bg -n production

# Undo to previous version
kubectl argo rollouts undo api-server-bg -n production
```

## Automated Rollback on Metric Degradation

The AnalysisRun continuously evaluates metrics during a rollout. When a metric fails its `failureCondition`, the rollout automatically aborts and reverts.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: comprehensive-analysis
  namespace: production
spec:
  args:
  - name: service-name
  - name: baseline-service
    value: api-server-stable
  metrics:
  - name: error-rate
    interval: 30s
    count: 10
    failureCondition: result[0] > 0.02
    failureLimit: 1
    consecutiveErrorLimit: 3
    provider:
      prometheus:
        address: http://prometheus-operated.monitoring.svc.cluster.local:9090
        query: >-
          sum(rate(http_requests_total{
            service="{{args.service-name}}",
            status=~"5.."
          }[2m]))
          /
          sum(rate(http_requests_total{
            service="{{args.service-name}}"
          }[2m]))
          OR on() vector(0)

  # Compare canary p99 against baseline (max 20% degradation)
  - name: latency-comparison
    interval: 60s
    count: 5
    failureCondition: >-
      result[0] > (
        scalar(
          histogram_quantile(0.99,
            sum(rate(http_request_duration_seconds_bucket{
              service="{{args.baseline-service}}"
            }[5m]))
            by (le)
          )
        ) * 1.2
      )
    provider:
      prometheus:
        address: http://prometheus-operated.monitoring.svc.cluster.local:9090
        query: >-
          histogram_quantile(0.99,
            sum(rate(http_request_duration_seconds_bucket{
              service="{{args.service-name}}"
            }[5m]))
            by (le)
          )

  # Custom business metric: order completion rate
  - name: order-completion-rate
    interval: 2m
    count: 3
    successCondition: result[0] >= 0.95
    failureLimit: 1
    provider:
      prometheus:
        address: http://prometheus-operated.monitoring.svc.cluster.local:9090
        query: >-
          sum(rate(orders_completed_total{
            service="{{args.service-name}}"
          }[5m]))
          /
          sum(rate(orders_created_total{
            service="{{args.service-name}}"
          }[5m]))
          OR on() vector(1)
```

### Monitoring Analysis Runs

```bash
# List active analysis runs
kubectl get analysisruns -n production

# Get details of a specific run
kubectl describe analysisrun <run-name> -n production

# Check which metric caused failure
kubectl get analysisrun <run-name> -n production -o jsonpath='{.status.metricResults}' | jq .

# Get rollout events showing analysis outcomes
kubectl get events -n production --field-selector involvedObject.name=api-server-bg
```

## Rollout Pause and Promote Automation

For CI/CD pipelines, automate the promotion or abort decision based on external signals.

```bash
#!/bin/bash
# ci-promote.sh: Promote rollout if all checks pass, abort otherwise

ROLLOUT_NAME="api-server"
NAMESPACE="production"
ANALYSIS_WAIT_SECONDS=300

# Wait for rollout to reach paused state
echo "Waiting for rollout to pause at manual gate..."
timeout 600 bash -c "
  until kubectl argo rollouts status ${ROLLOUT_NAME} -n ${NAMESPACE} 2>&1 | grep -q 'Paused'; do
    sleep 10
  done
"

# Run additional external checks (e.g., smoke test)
echo "Running smoke tests against canary..."
CANARY_SVC=$(kubectl get svc api-server-canary -n ${NAMESPACE} \
  -o jsonpath='{.spec.clusterIP}')

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  "http://${CANARY_SVC}/health")

if [ "$HTTP_CODE" != "200" ]; then
  echo "Smoke test failed with HTTP ${HTTP_CODE}, aborting rollout"
  kubectl argo rollouts abort "${ROLLOUT_NAME}" -n "${NAMESPACE}"
  exit 1
fi

# Check Prometheus metric directly
ERROR_RATE=$(curl -s "http://prometheus:9090/api/v1/query" \
  --data-urlencode "query=sum(rate(http_requests_total{service=\"api-server-canary\",status=~\"5..\"}[5m])) / sum(rate(http_requests_total{service=\"api-server-canary\"}[5m])) OR vector(0)" \
  | jq -r '.data.result[0].value[1] // "0"')

ERROR_RATE_PCT=$(echo "$ERROR_RATE * 100" | bc)
echo "Current canary error rate: ${ERROR_RATE_PCT}%"

if (( $(echo "$ERROR_RATE > 0.05" | bc -l) )); then
  echo "Error rate ${ERROR_RATE_PCT}% exceeds 5% threshold, aborting"
  kubectl argo rollouts abort "${ROLLOUT_NAME}" -n "${NAMESPACE}"
  exit 1
fi

echo "All checks passed. Promoting rollout..."
kubectl argo rollouts promote "${ROLLOUT_NAME}" -n "${NAMESPACE}"
echo "Promotion initiated successfully"
```

## Argo CD Integration

Argo CD manages the GitOps lifecycle while Argo Rollouts handles the deployment mechanics. Together they provide full GitOps progressive delivery.

### Application Configuration

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: api-server
  namespace: argocd
spec:
  project: production
  source:
    repoURL: https://github.com/example/api-server-manifests
    targetRevision: HEAD
    path: deploy/production
  destination:
    server: https://kubernetes.default.svc
    namespace: production
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
    - RespectIgnoreDifferences=true
  ignoreDifferences:
  # Ignore weight fields managed by Argo Rollouts
  - group: networking.istio.io
    kind: VirtualService
    jsonPointers:
    - /spec/http/0/route/0/weight
    - /spec/http/0/route/1/weight
  # Ignore replica counts managed by Rollouts controller
  - group: argoproj.io
    kind: Rollout
    jsonPointers:
    - /spec/replicas
```

The `ignoreDifferences` configuration is critical: Argo Rollouts continuously modifies weight values and replica counts. Without this, Argo CD would revert those changes on every sync.

### Rollout Status in Argo CD

Install the Argo Rollouts extension for Argo CD to display rollout status and progress in the Argo CD UI:

```bash
kubectl patch configmap argocd-cmd-params-cm -n argocd --type merge \
  -p '{"data":{"server.enable.progressive.syncs":"true"}}'

kubectl rollout restart deployment/argocd-applicationset-controller -n argocd
kubectl rollout restart deployment/argocd-server -n argocd
```

## Notifications and Alerting

Configure Argo Rollouts to send notifications on rollout events:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argo-rollouts-notification-configmap
  namespace: argo-rollouts
data:
  service.slack: |
    token: $slack-token
  template.rollout-completed: |
    message: Rollout {{.rollout.metadata.name}} completed successfully in {{.rollout.metadata.namespace}}
  template.rollout-aborted: |
    message: |
      :red_circle: Rollout {{.rollout.metadata.name}} ABORTED in {{.rollout.metadata.namespace}}
      Reason: {{.rollout.status.message}}
  trigger.on-rollout-completed: |
    - send: [rollout-completed]
      when: rollout.status.phase == 'Healthy'
  trigger.on-rollout-aborted: |
    - send: [rollout-aborted]
      when: rollout.status.phase == 'Degraded'
---
apiVersion: v1
kind: Secret
metadata:
  name: argo-rollouts-notification-secret
  namespace: argo-rollouts
stringData:
  slack-token: "xoxb-PLACEHOLDER-TOKEN-VALUE"
```

Add notification subscriptions to individual Rollout resources:

```yaml
metadata:
  annotations:
    notifications.argoproj.io/subscribe.on-rollout-completed.slack: production-deployments
    notifications.argoproj.io/subscribe.on-rollout-aborted.slack: production-alerts
```

## Production Checklist

Before enabling progressive delivery in production, verify:

1. **Metrics exist and are correct**: Query AnalysisTemplate Prometheus expressions manually. Verify they return non-null values for both stable and canary services.

2. **Service selectors are correct**: Canary and stable services must correctly select only canary or only stable ReplicaSets. Argo Rollouts manages the `rollouts-pod-template-hash` label for this.

3. **Readiness gates are strict**: Pods without fully passing readiness probes must not receive traffic. Set `maxUnavailable: 0` in canary strategies.

4. **Rollback validation**: Test rollback by triggering an intentional failure and verifying the rollout aborts and traffic reverts within the SLA.

5. **Traffic weight verification**: After each step, query the Prometheus metric for the canary service and verify the request share matches the expected weight.

```bash
# Verify traffic split matches expected weight
STABLE_RPS=$(kubectl exec -n monitoring prometheus-0 -- \
  promtool query instant \
  'sum(rate(http_requests_total{service="api-server-stable"}[2m]))')
CANARY_RPS=$(kubectl exec -n monitoring prometheus-0 -- \
  promtool query instant \
  'sum(rate(http_requests_total{service="api-server-canary"}[2m]))')

echo "Stable RPS: $STABLE_RPS"
echo "Canary RPS: $CANARY_RPS"
echo "Canary %: $(echo "scale=1; $CANARY_RPS * 100 / ($STABLE_RPS + $CANARY_RPS)" | bc)%"
```

Progressive delivery with Argo Rollouts transforms deployments from binary events (deploy/rollback) into continuous, measurable processes with automatic safeguards—eliminating the human reaction time gap that causes extended incidents when a bad deployment reaches production.
