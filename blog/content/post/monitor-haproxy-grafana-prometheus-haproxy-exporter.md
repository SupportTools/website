---
title: "Monitor HAProxy with Grafana and Prometheus (haproxy_exporter)"  
date: 2024-09-22T19:26:00-05:00  
draft: false  
tags: ["HAProxy", "Grafana", "Prometheus", "haproxy_exporter", "Monitoring"]  
categories:  
- HAProxy  
- Monitoring  
- Prometheus  
author: "Matthew Mattox - mmattox@support.tools."  
description: "Learn how to monitor HAProxy with Grafana and Prometheus using haproxy_exporter for real-time metrics and insights."  
more_link: "yes"  
url: "/monitor-haproxy-grafana-prometheus-haproxy-exporter/"  
---

HAProxy is a widely used open-source load balancer and reverse proxy for TCP and HTTP-based applications. Monitoring HAProxy performance and availability is crucial for ensuring your services remain healthy and responsive. In this post, we’ll walk through how to monitor HAProxy using Grafana, Prometheus, and `haproxy_exporter` to provide real-time insights into your load balancer’s performance.

<!--more-->

### Why Monitor HAProxy?

Monitoring HAProxy is essential to track its performance, manage traffic, and identify potential bottlenecks. Key metrics such as request rates, response times, active sessions, and errors give you the visibility needed to optimize your HAProxy instance.

With Prometheus scraping HAProxy metrics and Grafana visualizing them, you can set up dashboards and alerts to ensure your services remain stable and performant.

### Step 1: Install Prometheus and Grafana

If you haven’t already installed Prometheus and Grafana, follow these steps to get them up and running:

#### Install Prometheus:

```bash
# Download and install Prometheus
wget https://github.com/prometheus/prometheus/releases/download/v2.32.0/prometheus-2.32.0.linux-amd64.tar.gz
tar xvfz prometheus-2.32.0.linux-amd64.tar.gz
cd prometheus-2.32.0.linux-amd64
./prometheus --config.file=prometheus.yml
```

#### Install Grafana:

```bash
# Install Grafana on a Debian-based system
sudo apt-get install -y software-properties-common
sudo add-apt-repository "deb https://packages.grafana.com/oss/deb stable main"
sudo apt-get update
sudo apt-get install grafana
sudo systemctl start grafana-server
```

Access Grafana by navigating to `http://localhost:3000` in your browser, and log in using the default credentials (`admin/admin`).

### Step 2: Install haproxy_exporter

The `haproxy_exporter` exposes HAProxy metrics in a format that Prometheus can scrape. Install it on the same server running HAProxy or on a separate monitoring server.

1. **Download and install haproxy_exporter**:

```bash
wget https://github.com/prometheus/haproxy_exporter/releases/download/v0.12.0/haproxy_exporter-0.12.0.linux-amd64.tar.gz
tar xvfz haproxy_exporter-0.12.0.linux-amd64.tar.gz
sudo mv haproxy_exporter /usr/local/bin/
```

2. **Configure HAProxy to expose statistics**:

To allow `haproxy_exporter` to collect metrics, HAProxy needs to expose its statistics endpoint. Edit your `haproxy.cfg` file and add a stats section:

```bash
listen stats
    bind *:8404
    stats enable
    stats uri /stats
    stats refresh 10s
    stats auth admin:password
```

Restart HAProxy to apply the changes:

```bash
sudo systemctl restart haproxy
```

3. **Start haproxy_exporter**:

Run the `haproxy_exporter` with the HAProxy stats URL and credentials:

```bash
haproxy_exporter --haproxy.scrape-uri="http://admin:password@localhost:8404/stats;csv"
```

### Step 3: Configure Prometheus to Scrape haproxy_exporter

Add the `haproxy_exporter` scrape target to your Prometheus configuration (`prometheus.yml`):

```yaml
scrape_configs:
  - job_name: 'haproxy_exporter'
    static_configs:
      - targets: ['localhost:9101']
```

Reload Prometheus to apply the new configuration:

```bash
sudo systemctl reload prometheus
```

### Step 4: Visualize HAProxy Metrics in Grafana

Now that Prometheus is scraping HAProxy metrics, you can visualize them in Grafana.

1. **Add Prometheus as a Data Source**:

- In Grafana, go to **Configuration > Data Sources**.
- Click **Add data source**, select **Prometheus**, and enter the URL for your Prometheus instance (e.g., `http://localhost:9090`).
- Click **Save & Test** to verify the connection.

2. **Import HAProxy Dashboard**:

To save time, you can import a pre-configured HAProxy dashboard. Here’s how to import one:

- Go to **Dashboards > Manage > Import**.
- Enter dashboard ID `367` (or search for "HAProxy Exporter" in Grafana’s dashboard library).
- Select your Prometheus data source and click **Import**.

This dashboard provides real-time metrics such as:
- Active and inactive sessions.
- Request rates and response times.
- Backend status and health checks.
- Error rates and retries.

### Step 5: Set Up Alerts (Optional)

You can set up alerts in Grafana for critical HAProxy metrics, such as high response times, connection errors, or overloaded backends.

1. **Create a new alert**:

- Go to the panel (e.g., "Response Time") where you want to create an alert.
- Click the panel title and select **Edit**.
- Go to the **Alert** tab and define your alert conditions (e.g., trigger an alert if the response time exceeds 500ms).

2. **Configure notification channels**:

- Go to **Alerting > Notification channels**.
- Add your preferred notification method (email, Slack, etc.) and link it to the alert you’ve created.

### Final Thoughts

By monitoring HAProxy with Grafana and Prometheus using `haproxy_exporter`, you gain valuable insights into the performance and health of your load balancer. With real-time metrics and alerting, you can quickly identify issues, optimize performance, and ensure high availability for your services.
