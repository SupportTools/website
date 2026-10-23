---
title: "Monitor HAProxy with Prometheus and Grafana (2026)"
date: 2024-09-22T19:26:00-05:00
lastmod: 2026-10-23
draft: false
tags: ["HAProxy", "Grafana", "Prometheus", "haproxy_exporter", "Monitoring"]
categories:
- Monitoring
- Prometheus
author: "Matthew Mattox - mmattox@support.tools"
description: "haproxy_exporter is retired. Use HAProxy's built-in Prometheus endpoint, scrape it with Prometheus, and graph and alert on it in Grafana. Full config."
more_link: "yes"
url: "/monitor-haproxy-grafana-prometheus-haproxy-exporter/"
quick_fix: |
  Skip `haproxy_exporter`: it was retired and archived in 2023. HAProxy 2.0+ has a native Prometheus endpoint. Add this to `haproxy.cfg`:
  `frontend prometheus` / `bind *:8405` / `mode http` / `http-request use-service prometheus-exporter if { path /metrics }` / `no log`,
  reload HAProxy, check it with `curl -s localhost:8405/metrics | head`, then point a Prometheus scrape job at `<haproxy-host>:8405`.
---

HAProxy is a widely used open-source load balancer and reverse proxy for TCP and HTTP applications. This guide shows the current way to monitor it: HAProxy's built-in Prometheus exporter, a Prometheus scrape job, a Grafana dashboard, and a few alert rules. It also covers the legacy `haproxy_exporter` for older HAProxy versions that cannot use the native endpoint.

<!--more-->

## haproxy_exporter vs the built-in exporter

The standalone [`haproxy_exporter`](https://github.com/prometheus/haproxy_exporter) scraped HAProxy's CSV stats page and translated it to Prometheus metrics. Its repository was archived on March 8, 2023, and its README says the exporter is retired and asks users to move to HAProxy's built-in support.

HAProxy has shipped a native Prometheus exporter since version 2.0 ([HAProxy docs](https://www.haproxy.com/documentation/haproxy-configuration-tutorials/alerts-and-monitoring/prometheus/)). It exposes more metrics, needs no extra process, and uses `haproxy_frontend_*`, `haproxy_backend_*`, `haproxy_server_*` and `haproxy_process_*` metric names.

| | Built-in exporter | haproxy_exporter (legacy) |
|---|---|---|
| HAProxy version | 2.0 and later | Any version with a CSV stats page |
| Extra process | No | Yes, default port 9101 |
| Maintained | Yes, part of HAProxy | No, archived in 2023 |

Use the built-in exporter unless you are stuck on HAProxy 1.x.

## Step 1: Confirm your HAProxy build includes the exporter

Distribution packages and the official Docker images normally include it. Check:

```bash
haproxy -vv | grep -i prometheus
```

You should see the Prometheus exporter listed among the built-in services. If you build from source, HAProxy 2.4 and later need `USE_PROMEX=1` on the `make` command line.

## Step 2: Enable the Prometheus endpoint in haproxy.cfg

Add a dedicated frontend:

```haproxy
frontend prometheus
    bind *:8405
    mode http
    http-request use-service prometheus-exporter if { path /metrics }
    no log
```

Validate and reload:

```bash
sudo haproxy -c -f /etc/haproxy/haproxy.cfg
sudo systemctl reload haproxy
curl -s http://localhost:8405/metrics | grep -m5 '^haproxy_'
```

Restrict port 8405 to your Prometheus servers with a firewall rule or an ACL, because the metrics reveal backend and server names.

Some per-server counters are only returned when you ask for them, for example `http://localhost:8405/metrics?extra-counters=on`.

## Step 3: Install Prometheus and Grafana

If you do not already have them, install Prometheus from the [official releases](https://github.com/prometheus/prometheus/releases) (v3.15.1 was the latest at the time of this update):

```bash
VERSION=3.15.1
wget https://github.com/prometheus/prometheus/releases/download/v${VERSION}/prometheus-${VERSION}.linux-amd64.tar.gz
tar xvfz prometheus-${VERSION}.linux-amd64.tar.gz
cd prometheus-${VERSION}.linux-amd64
./prometheus --config.file=prometheus.yml
```

Install Grafana OSS on Debian or Ubuntu from the current `apt.grafana.com` repository (the old `packages.grafana.com` line and `add-apt-repository` method in older guides no longer apply):

```bash
sudo apt-get install -y apt-transport-https wget gnupg
sudo mkdir -p /etc/apt/keyrings
sudo wget -O /etc/apt/keyrings/grafana.asc https://apt.grafana.com/gpg-full.key
sudo chmod 644 /etc/apt/keyrings/grafana.asc
echo "deb [signed-by=/etc/apt/keyrings/grafana.asc] https://apt.grafana.com stable main" | sudo tee /etc/apt/sources.list.d/grafana.list
sudo apt-get update
sudo apt-get install -y grafana
sudo systemctl enable --now grafana-server
```

Open `http://localhost:3000`, log in with `admin`/`admin`, and set a new password when prompted.

## Step 4: Configure Prometheus to scrape HAProxy

```yaml
scrape_configs:
  - job_name: 'haproxy'
    metrics_path: /metrics
    static_configs:
      - targets: ['haproxy-01.example.com:8405', 'haproxy-02.example.com:8405']
```

Reload Prometheus (`sudo systemctl reload prometheus`, or send `SIGHUP` to the process) and check **Status > Targets** in the Prometheus UI. The `haproxy` job should be `UP`.

## Step 5: Build the Grafana dashboard

1. Add the data source: **Connections > Data sources > Add data source > Prometheus**, URL `http://localhost:9090`, then **Save & test**.
2. Import a dashboard: **Dashboards > New > Import**. Dashboard ID **12693** ("HAProxy", for HAProxy 2 and later with Prometheus data) is a common starting point. The old ID 367 was built for `haproxy_exporter` metric names and shows empty panels with the built-in exporter.
3. Select your Prometheus data source and import.

Useful panel queries with the built-in exporter:

```promql
# Requests per second per frontend
sum by (proxy) (rate(haproxy_frontend_http_requests_total[5m]))

# 5xx responses per second per backend
sum by (proxy) (rate(haproxy_backend_http_responses_total{code="5xx"}[5m]))

# Current sessions per backend
sum by (proxy) (haproxy_backend_current_sessions)

# Servers that are not UP
haproxy_server_status{state!="UP"} == 1
```

## Step 6: Alerts

Grafana's legacy panel alerts and "Notification channels" were removed in Grafana 11. Create alerts under **Alerting > Alert rules**, and send them through **Alerting > Contact points**. If you prefer Prometheus rules with Alertmanager, these are good starting points:

```yaml
groups:
  - name: haproxy
    rules:
      - alert: HAProxyBackendDown
        expr: haproxy_backend_active_servers == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "HAProxy backend {{ $labels.proxy }} has no active servers"
      - alert: HAProxyHigh5xxRate
        expr: |
          sum by (proxy) (rate(haproxy_backend_http_responses_total{code="5xx"}[5m]))
            / sum by (proxy) (rate(haproxy_backend_http_responses_total[5m])) > 0.05
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "More than 5% 5xx responses on backend {{ $labels.proxy }}"
```

## Legacy: haproxy_exporter for old HAProxy versions

Only use this if you cannot upgrade past HAProxy 1.x. Expose the CSV stats page:

```haproxy
listen stats
    bind *:8404
    stats enable
    stats uri /stats
    stats refresh 10s
    stats auth admin:password
```

Then run the last `haproxy_exporter` release (v0.15.0) against it:

```bash
haproxy_exporter --haproxy.scrape-uri="http://admin:password@localhost:8404/stats;csv"
```

It listens on port 9101 by default. Expect no further fixes for it.

## FAQ

### Is haproxy_exporter deprecated?

Yes. The Prometheus project retired it and archived the repository on March 8, 2023. Use HAProxy's built-in exporter, available since HAProxy 2.0.

### What port does the HAProxy Prometheus exporter use?

None by default. You choose it in the `bind` line of the frontend that runs `use-service prometheus-exporter`. Port 8405 is the convention in HAProxy's own documentation.

### Why does my old Grafana HAProxy dashboard show "No data"?

Dashboards such as 367 were built for `haproxy_exporter`, which labels series with `frontend`, `backend` and `server`. The built-in exporter uses a `proxy` label and partly different metric names, so those queries match nothing. Import a dashboard built for the native exporter (such as 12693) or rewrite the queries.

### How do I monitor HAProxy running as a Kubernetes ingress controller?

The HAProxy Kubernetes Ingress Controller exposes its own Prometheus endpoint; scrape it with a ServiceMonitor or PodMonitor. See [HAProxy Ingress Advanced Features](/haproxy-ingress-advanced-features-enterprise-kubernetes-guide/) for that setup.

## Related guides

- [HAProxy Ingress Advanced Features and Enterprise Deployment](/haproxy-ingress-advanced-features-enterprise-kubernetes-guide/)
- [Ingress-NGINX for RKE2: Troubleshooting and 2026 Retirement](/rke2-ingress-nginx/)
- [Running RKE2 Ingress-NGINX with an External LoadBalancer](/rke2-ingress-nginx-external-lb/)
