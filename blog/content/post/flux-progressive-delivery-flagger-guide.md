---
title: "Flux and Flagger: Progressive Delivery with GitOps"
date: 2027-10-12T00:00:00-05:00
draft: false
tags: ["Flux", "Flagger", "GitOps", "Progressive Delivery", "Canary"]
categories:
- GitOps
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to progressive delivery using Flux and Flagger. Covers Canary CRD configuration, Prometheus analysis templates, automated rollbacks, A/B testing, blue-green deployments, service mesh integration, and multi-cluster progressive delivery."
more_link: "yes"
url: "/flux-progressive-delivery-flagger-guide/"
---

Progressive delivery extends GitOps beyond simple deployments by introducing controlled, metric-driven rollouts. Flagger, operating alongside Flux, automates canary deployments, A/B tests, and blue-green releases by observing real traffic metrics and automatically rolling back when thresholds are breached. This combination eliminates the manual monitoring overhead of new deployments while enforcing objective promotion criteria based on application behavior in production.

<!--more-->

# Flux and Flagger: Progressive Delivery with GitOps

## Section 1: Architecture Overview

Flagger operates as a Kubernetes controller that watches `Canary` CRDs. When a Canary-managed Deployment is updated, Flagger:

1. Creates a `canary` Deployment with the new version
2. Shifts a configurable percentage of traffic to the canary
3. Evaluates metric analysis at each step
4. Promotes the canary to primary if all analyses pass
5. Rolls back automatically if any analysis fails

Flux manages the GitOps workflow — synchronizing manifests from Git repositories and triggering Flagger's analysis process through Deployment image updates or Helm release upgrades.

### Installation

```bash
# Install Flux
flux install

# Install Flagger with Prometheus integration
helm repo add flagger https://flagger.app
helm repo update

helm upgrade --install flagger flagger/flagger \
  --namespace flagger-system \
  --create-namespace \
  --set prometheus.install=false \
  --set meshProvider=nginx \
  --set metricsServer=http://prometheus-operated.monitoring.svc.cluster.local:9090 \
  --set slack.url=https://hooks.slack.com/services/T0000000/B0000000/placeholder-webhook-url \
  --set slack.channel=deployments \
  --set slack.user=flagger

# Install Flagger load tester (optional, for built-in traffic generation)
helm upgrade --install flagger-loadtester flagger/loadtester \
  --namespace flagger-system
```

## Section 2: Flagger Canary CRD Configuration

### Basic Canary with NGINX Ingress

```yaml
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: api-server
  namespace: production
spec:
  # Target deployment to manage
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-server

  # Ingress reference for traffic splitting
  ingressRef:
    apiVersion: networking.k8s.io/v1
    kind: Ingress
    name: api-server

  # HPA reference — Flagger will manage both primary and canary HPAs
  autoscalerRef:
    apiVersion: autoscaling/v2
    kind: HorizontalPodAutoscaler
    name: api-server

  progressDeadlineSeconds: 600

  service:
    # Port configuration
    port: 8080
    targetPort: 8080
    portDiscovery: true

    # Header for routing canary traffic directly (for testing)
    headers:
      request:
        add:
          x-canary: "true"

  analysis:
    # Step interval: evaluate metrics every 60 seconds
    interval: 60s
    # Number of steps before full promotion
    threshold: 10
    # Percentage to increase traffic at each step
    stepWeight: 10
    # Maximum percentage sent to canary
    maxWeight: 50

    # Metric analyses that must pass at each step
    metrics:
      - name: request-success-rate
        thresholdRange:
          min: 99
        interval: 1m

      - name: request-duration
        thresholdRange:
          max: 500
        interval: 1m

    # Webhook tests run before traffic shifting
    webhooks:
      - name: acceptance-test
        type: pre-rollout
        url: http://flagger-loadtester.flagger-system/
        timeout: 30s
        metadata:
          type: bash
          cmd: "curl -sf http://api-server-canary.production/health"

      - name: load-test
        type: rollout
        url: http://flagger-loadtester.flagger-system/
        metadata:
          type: cmd
          cmd: "hey -z 1m -q 10 -c 2 http://api-server-canary.production/"
```

### Deployment Resource Managed by Flagger

The Deployment that Flagger manages must be present in Git:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
  namespace: production
  labels:
    app: api-server
spec:
  replicas: 3
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
          image: support-tools/api-server:v2.5.0
          ports:
            - containerPort: 8080
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
          readinessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 15
            periodSeconds: 20
```

When Flux detects a new image tag in the Deployment manifest, it applies the update. Flagger intercepts this change and begins the progressive rollout instead of applying the update directly.

## Section 3: Analysis Templates with Prometheus Metrics

MetricTemplates allow reusing metric analysis logic across multiple Canary resources.

### Custom Metric Templates

```yaml
# Error rate template
apiVersion: flagger.app/v1beta1
kind: MetricTemplate
metadata:
  name: http-error-rate
  namespace: flagger-system
spec:
  provider:
    type: prometheus
    address: http://prometheus-operated.monitoring.svc.cluster.local:9090
  query: |
    100 - sum(
      rate(
        http_requests_total{
          namespace="{{ namespace }}",
          pod=~"{{ target }}-[0-9a-zA-Z]+(-[0-9a-zA-Z]+)",
          status!~"5.."
        }[{{ interval }}]
      )
    )
    /
    sum(
      rate(
        http_requests_total{
          namespace="{{ namespace }}",
          pod=~"{{ target }}-[0-9a-zA-Z]+(-[0-9a-zA-Z]+)"
        }[{{ interval }}]
      )
    ) * 100
```

```yaml
# P99 latency template
apiVersion: flagger.app/v1beta1
kind: MetricTemplate
metadata:
  name: p99-latency
  namespace: flagger-system
spec:
  provider:
    type: prometheus
    address: http://prometheus-operated.monitoring.svc.cluster.local:9090
  query: |
    histogram_quantile(
      0.99,
      sum(
        rate(
          http_request_duration_seconds_bucket{
            namespace="{{ namespace }}",
            pod=~"{{ target }}-[0-9a-zA-Z]+(-[0-9a-zA-Z]+)"
          }[{{ interval }}]
        )
      ) by (le)
    )
```

```yaml
# Database connection pool saturation
apiVersion: flagger.app/v1beta1
kind: MetricTemplate
metadata:
  name: db-pool-saturation
  namespace: flagger-system
spec:
  provider:
    type: prometheus
    address: http://prometheus-operated.monitoring.svc.cluster.local:9090
  query: |
    sum(
      pg_pool_active_connections{
        namespace="{{ namespace }}",
        pod=~"{{ target }}-[0-9a-zA-Z]+(-[0-9a-zA-Z]+)"
      }
    )
    /
    sum(
      pg_pool_size{
        namespace="{{ namespace }}",
        pod=~"{{ target }}-[0-9a-zA-Z]+(-[0-9a-zA-Z]+)"
      }
    ) * 100
```

### Using Templates in Canary Analysis

```yaml
spec:
  analysis:
    interval: 60s
    threshold: 10
    stepWeight: 10
    maxWeight: 50
    metrics:
      - name: http-error-rate
        templateRef:
          name: http-error-rate
          namespace: flagger-system
        thresholdRange:
          min: 99.0
        interval: 2m

      - name: p99-latency
        templateRef:
          name: p99-latency
          namespace: flagger-system
        thresholdRange:
          max: 0.5  # 500ms in seconds
        interval: 2m

      - name: db-pool-saturation
        templateRef:
          name: db-pool-saturation
          namespace: flagger-system
        thresholdRange:
          max: 80  # Alert if pool > 80% saturated
        interval: 2m
```

## Section 4: Automated Rollback Triggers

Flagger automatically rolls back when:
- A metric analysis fails for `threshold` consecutive steps
- A webhook returns a non-2xx response
- The `progressDeadlineSeconds` is exceeded
- The canary pods fail to become ready

### Manual Rollback

```bash
# Force an immediate rollback by annotating the Canary
kubectl -n production annotate canary api-server \
  flagger.app/abort=true

# Or by updating the Deployment back to the previous image
# (Flux will pick up the Git revert and apply it)
```

### Rollback Notification Webhooks

```yaml
spec:
  analysis:
    webhooks:
      # Pre-rollout smoke test
      - name: smoke-test
        type: pre-rollout
        url: http://flagger-loadtester.flagger-system/
        timeout: 60s
        metadata:
          type: bash
          cmd: |
            curl -sf \
              -H "x-canary: true" \
              http://api-server.production/api/v1/health | \
              jq -e '.status == "ok"'

      # Post-rollout verification
      - name: post-deploy-verification
        type: post-rollout
        url: http://flagger-loadtester.flagger-system/
        timeout: 120s
        metadata:
          type: bash
          cmd: |
            # Run integration test suite against new version
            curl -sf \
              http://integration-tests.cicd.svc.cluster.local/run \
              -d '{"target":"api-server","suite":"smoke"}'

      # Notification on rollback
      - name: rollback-notification
        type: rollback
        url: https://hooks.slack.com/services/T0000000/B0000000/placeholder-webhook-url
        metadata:
          text: |
            Canary {{ name }} in namespace {{ namespace }} rolled back.
            Analysis failed: {{ failedMetric }}
```

## Section 5: A/B Testing with Header-Based Routing

A/B testing routes specific users to the canary based on HTTP headers, cookies, or query parameters instead of random traffic splitting.

### Header-Based A/B Test Configuration

```yaml
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: frontend
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: frontend
  ingressRef:
    apiVersion: networking.k8s.io/v1
    kind: Ingress
    name: frontend
  service:
    port: 80
    targetPort: 3000
  analysis:
    # A/B test: run for fixed iterations regardless of traffic percentage
    iterations: 20
    interval: 60s
    threshold: 5
    # Route users with this header to canary
    match:
      - headers:
          x-beta-user:
            exact: "true"
      - headers:
          cookie:
            regex: ".*betaFeatures=enabled.*"
    metrics:
      - name: request-success-rate
        thresholdRange:
          min: 99
        interval: 1m
    webhooks:
      - name: feature-flag-check
        type: confirm-rollout
        url: http://flagger-loadtester.flagger-system/
        metadata:
          type: bash
          cmd: |
            # Verify feature flag is set correctly for canary
            curl -sf \
              -H "x-beta-user: true" \
              http://frontend-canary.production/api/features | \
              jq -e '.newCheckout == true'
```

### Session Stickiness for A/B Tests

```yaml
spec:
  service:
    # Configure NGINX sticky sessions for consistent user experience
    apex:
      annotations:
        nginx.ingress.kubernetes.io/affinity: cookie
        nginx.ingress.kubernetes.io/session-cookie-name: "flagger-canary"
        nginx.ingress.kubernetes.io/session-cookie-expires: "86400"
        nginx.ingress.kubernetes.io/session-cookie-max-age: "86400"
        nginx.ingress.kubernetes.io/session-cookie-hash: sha1
```

## Section 6: Blue-Green Deployments

Blue-green deployments run two full copies of the application and switch traffic instantly after validation.

```yaml
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: payment-service
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: payment-service
  progressDeadlineSeconds: 300
  service:
    port: 8080
    targetPort: 8080
  analysis:
    # Blue-green: jump from 0% to 100% after analysis
    stepWeight: 100
    threshold: 1
    interval: 30s
    # Run analysis before switching
    iterations: 5
    metrics:
      - name: request-success-rate
        thresholdRange:
          min: 99.9
        interval: 1m
    webhooks:
      # Gate: require manual approval for payment service
      - name: manual-approval
        type: confirm-promotion
        url: http://flagger-loadtester.flagger-system/
        metadata:
          type: bash
          cmd: |
            echo "Waiting for approval at https://approvals.example.com/payment-service/$(date +%s)"
            sleep 300
            exit 0  # In practice, poll an approval API here
```

### Blue-Green Traffic Switch

Once `confirm-promotion` webhook succeeds, Flagger:
1. Scales up the green (canary) deployment
2. Runs analysis against green
3. Atomically routes 100% of traffic to green
4. Scales down blue (old primary)

```bash
# Watch blue-green progression
kubectl -n production describe canary payment-service
kubectl -n production get canary payment-service -w

# Check traffic distribution
kubectl -n production get ingress payment-service \
  -o jsonpath='{.metadata.annotations}' | python3 -m json.tool
```

## Section 7: Integration with Istio for Traffic Splitting

Flagger integrates deeply with Istio's VirtualService and DestinationRule for fine-grained traffic management.

### Istio-Based Canary

```yaml
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: api-server
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-server
  provider: istio
  service:
    port: 8080
    targetPort: 8080
    # Istio-specific gateways
    gateways:
      - public-gateway.istio-system.svc.cluster.local
    hosts:
      - api.production.example.com
    trafficPolicy:
      tls:
        mode: ISTIO_MUTUAL
    retries:
      attempts: 3
      perTryTimeout: 10s
      retryOn: "gateway-error,connect-failure,refused-stream"
  analysis:
    interval: 30s
    threshold: 10
    stepWeight: 5
    maxWeight: 50
    metrics:
      # Istio-native metrics via Prometheus
      - name: request-success-rate
        interval: 1m
        thresholdRange:
          min: 99
      - name: request-duration
        interval: 1m
        thresholdRange:
          max: 300
```

### Istio MetricTemplate Using Istio Telemetry

```yaml
apiVersion: flagger.app/v1beta1
kind: MetricTemplate
metadata:
  name: istio-error-rate
  namespace: flagger-system
spec:
  provider:
    type: prometheus
    address: http://prometheus-operated.monitoring.svc.cluster.local:9090
  query: |
    100 - (
      sum(
        rate(
          istio_requests_total{
            destination_workload_namespace="{{ namespace }}",
            destination_workload="{{ target }}",
            response_code!~"5.*"
          }[{{ interval }}]
        )
      ) /
      sum(
        rate(
          istio_requests_total{
            destination_workload_namespace="{{ namespace }}",
            destination_workload="{{ target }}"
          }[{{ interval }}]
        )
      )
    ) * 100
```

## Section 8: Linkerd Traffic Splitting

For clusters using Linkerd as the service mesh:

```yaml
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: web-app
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: web-app
  provider: linkerd
  service:
    port: 8080
  analysis:
    interval: 30s
    threshold: 5
    stepWeight: 10
    maxWeight: 50
    metrics:
      - name: request-success-rate
        interval: 1m
        thresholdRange:
          min: 99
      - name: request-duration
        interval: 1m
        thresholdRange:
          max: 250
```

Flagger creates a Linkerd `TrafficSplit` resource to distribute traffic:

```yaml
# Flagger creates this automatically:
apiVersion: split.smi-spec.io/v1alpha1
kind: TrafficSplit
metadata:
  name: web-app
  namespace: production
spec:
  service: web-app
  backends:
    - service: web-app-primary
      weight: 90
    - service: web-app-canary
      weight: 10
```

## Section 9: Flux Image Automation for Automated Releases

Flux Image Automation updates Deployment manifests in Git when new container images are pushed, triggering Flagger's analysis automatically.

### ImageRepository and ImagePolicy

```yaml
# Watch the registry for new images
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageRepository
metadata:
  name: api-server
  namespace: flux-system
spec:
  image: support-tools/api-server
  interval: 5m
  secretRef:
    name: registry-credentials
---
# Policy to select the latest semver patch on a minor version
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: api-server
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: api-server
  policy:
    semver:
      range: ">=2.5.0 <3.0.0"
```

### ImageUpdateAutomation

```yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageUpdateAutomation
metadata:
  name: automated-releases
  namespace: flux-system
spec:
  interval: 5m
  sourceRef:
    kind: GitRepository
    name: gitops-config
  git:
    checkout:
      ref:
        branch: main
    commit:
      author:
        email: fluxbot@support.tools
        name: Flux Bot
      messageTemplate: |
        chore: update images

        Updated image(s):
        {{ range .Updated.Images -}}
        - {{ .Namespace }}/{{ .Name }}: {{ .NewTag }}
        {{ end -}}
    push:
      branch: main
  update:
    path: ./production
    strategy: Setters
```

Mark the Deployment image with a Flux setter comment:

```yaml
spec:
  template:
    spec:
      containers:
        - name: api-server
          image: support-tools/api-server:v2.5.0 # {"$imagepolicy": "flux-system:api-server"}
```

When Flux detects `v2.5.1` in the registry, it updates the YAML file to `v2.5.1`, commits to Git, and Flux reconciles the Deployment. Flagger detects the Deployment change and starts the progressive rollout.

## Section 10: Multi-Cluster Progressive Delivery

For deploying across multiple clusters in sequence, combine Flux Kustomizations with Flagger Canaries.

### Cluster Order Configuration

```
├── clusters/
│   ├── staging/
│   │   └── flux-system/
│   │       └── kustomization.yaml  # Sync source
│   ├── prod-us-east-1/
│   └── prod-us-west-2/
├── production/
│   └── api-server/
│       ├── deployment.yaml
│       └── canary.yaml
```

### Flux Kustomization with Health Checks

```yaml
# First: staging Kustomization
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: api-server-staging
  namespace: flux-system
spec:
  interval: 5m
  sourceRef:
    kind: GitRepository
    name: gitops-config
  path: ./staging/api-server
  prune: true
  targetNamespace: staging
  healthChecks:
    - apiVersion: flagger.app/v1beta1
      kind: Canary
      name: api-server
      namespace: staging
  timeout: 10m
---
# Second: production us-east-1 Kustomization
# dependsOn staging to ensure staging promotion completes first
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: api-server-prod-us-east-1
  namespace: flux-system
spec:
  interval: 5m
  dependsOn:
    - name: api-server-staging
  sourceRef:
    kind: GitRepository
    name: gitops-config
  path: ./production/api-server
  prune: true
  kubeConfig:
    secretRef:
      name: prod-us-east-1-kubeconfig
  healthChecks:
    - apiVersion: flagger.app/v1beta1
      kind: Canary
      name: api-server
      namespace: production
  timeout: 20m
---
# Third: production us-west-2
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: api-server-prod-us-west-2
  namespace: flux-system
spec:
  interval: 5m
  dependsOn:
    - name: api-server-prod-us-east-1
  sourceRef:
    kind: GitRepository
    name: gitops-config
  path: ./production/api-server
  prune: true
  kubeConfig:
    secretRef:
      name: prod-us-west-2-kubeconfig
  healthChecks:
    - apiVersion: flagger.app/v1beta1
      kind: Canary
      name: api-server
      namespace: production
  timeout: 20m
```

The Canary health check passes only when Flagger reports `status.phase: Succeeded`. This ensures each cluster fully completes its progressive rollout before the next cluster begins.

## Section 11: Observability and Alerting

### Flagger Metrics in Prometheus

```bash
kubectl -n flagger-system port-forward svc/flagger-prometheus 9090:9090

# Key Flagger metrics
curl -s http://localhost:9090/api/v1/query \
  --data-urlencode 'query=flagger_canary_status' | python3 -m json.tool
```

Key metrics:

```
flagger_canary_status{name, namespace, phase}
flagger_canary_weight{name, namespace}
flagger_canary_iterations{name, namespace}
```

### PrometheusRule for Flagger

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: flagger-alerts
  namespace: flagger-system
  labels:
    release: prometheus
spec:
  groups:
    - name: flagger
      rules:
        - alert: FlaggerCanaryRolledBack
          expr: flagger_canary_status{phase="Failed"} == 1
          for: 1m
          labels:
            severity: warning
          annotations:
            summary: "Flagger canary {{ $labels.namespace }}/{{ $labels.name }} rolled back"
            description: "Canary deployment failed analysis and rolled back."

        - alert: FlaggerCanaryProgressing
          expr: flagger_canary_status{phase="Progressing"} == 1
          for: 30m
          labels:
            severity: info
          annotations:
            summary: "Flagger canary {{ $labels.namespace }}/{{ $labels.name }} progressing for 30min"

        - alert: FlaggerCanaryStuck
          expr: |
            (time() - flagger_canary_status_timestamp{phase="Progressing"}) > 3600
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Flagger canary {{ $labels.namespace }}/{{ $labels.name }} appears stuck"
```

### Checking Canary Status

```bash
# Get overview of all canaries
kubectl get canaries --all-namespaces

# Detailed status for a canary
kubectl -n production describe canary api-server

# View Flagger events
kubectl -n production get events \
  --field-selector reason=Synced \
  --sort-by='.lastTimestamp' | grep api-server

# Check Flagger controller logs
kubectl -n flagger-system logs deployment/flagger \
  | grep "api-server" | tail -20
```

## Section 12: Operational Playbooks

### Pause a Canary Rollout

```bash
# Pause by annotating the Canary resource
kubectl -n production annotate canary api-server \
  flagger.app/pause=true

# Resume
kubectl -n production annotate canary api-server \
  flagger.app/pause-
```

### Skip Analysis for Emergency Promotions

```bash
# Force promotion by annotating with confirmed-promote
kubectl -n production annotate canary api-server \
  flagger.app/confirmed-promote=true

# Note: This bypasses all metric and webhook checks.
# Use only for emergency situations.
```

### Debugging Failed Canaries

```bash
#!/bin/bash
# flagger-debug.sh NAMESPACE CANARY_NAME
NAMESPACE=$1
CANARY=$2

echo "=== Canary Status ==="
kubectl -n "${NAMESPACE}" get canary "${CANARY}" \
  -o jsonpath='{.status}' | python3 -m json.tool

echo ""
echo "=== Recent Conditions ==="
kubectl -n "${NAMESPACE}" get canary "${CANARY}" \
  -o jsonpath='{.status.conditions}' | python3 -m json.tool

echo ""
echo "=== Flagger Events ==="
kubectl -n "${NAMESPACE}" get events \
  --field-selector involvedObject.name="${CANARY}" \
  --sort-by='.lastTimestamp'

echo ""
echo "=== Canary Pod Logs (last 50 lines) ==="
CANARY_POD=$(kubectl -n "${NAMESPACE}" get pods \
  -l "app=${CANARY}-canary" \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
if [ -n "${CANARY_POD}" ]; then
  kubectl -n "${NAMESPACE}" logs "${CANARY_POD}" --tail=50
fi

echo ""
echo "=== Flagger Controller Logs for this Canary ==="
kubectl -n flagger-system logs deployment/flagger \
  | grep "${NAMESPACE}/${CANARY}" | tail -30
```

The Flux and Flagger combination provides automated, metric-driven delivery that eliminates the manual observation overhead of traditional deployments. With automated rollback, configurable promotion criteria, and multi-cluster orchestration via Flux's dependency graph, teams can deploy to production continuously with confidence that failures are detected and reversed before they impact the majority of users.
