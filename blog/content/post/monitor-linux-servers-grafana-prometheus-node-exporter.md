---
title: "Monitor Linux Servers with Grafana and Prometheus (node_exporter)"  
date: 2024-09-23T19:26:00-05:00  
draft: false  
tags: ["Linux", "Grafana", "Prometheus", "node_exporter", "Monitoring"]  
categories:  
- Linux  
- Monitoring  
- Prometheus  
author: "Matthew Mattox - mmattox@support.tools."  
description: "Learn how to monitor Linux servers with Grafana and Prometheus using node_exporter for real-time metrics and insights."  
more_link: "yes"  
url: "/monitor-linux-servers-grafana-prometheus-node-exporter/"  
---

Monitoring Linux servers is critical for maintaining system health, optimizing performance, and identifying potential issues before they escalate. With Prometheus and Grafana, you can collect and visualize system metrics using `node_exporter`, a Prometheus exporter designed to gather hardware and OS metrics from Linux systems. In this post, we’ll guide you through setting up Prometheus, Grafana, and `node_exporter` to monitor your Linux servers.

<!--more-->

### Why Monitor Linux Servers?

Monitoring Linux servers helps you track system performance metrics such as CPU usage, memory utilization, disk I/O, network traffic, and more. By collecting and visualizing these metrics, you gain deeper insights into your server's performance, allowing you to make informed decisions about scaling, resource allocation, and troubleshooting.

### Step 1: Install Prometheus and Grafana

First, ensure Prometheus and Grafana are installed on your monitoring server. If they aren’t already installed, follow these steps:

#### Install Prometheus

```bash
# Download and install Prometheus
wget https://github.com/prometheus/prometheus/releases/download/v2.32.0/prometheus-2.32.0.linux-amd64.tar.gz
tar xvfz prometheus-2.32.0.linux-amd64.tar.gz
cd prometheus-2.32.0.linux-amd64
./prometheus --config.file=prometheus.yml
```

#### Install Grafana

```bash
# Install Grafana on a Debian-based system
sudo apt-get install -y software-properties-common
sudo add-apt-repository "deb https://packages.grafana.com/oss/deb stable main"
sudo apt-get update
sudo apt-get install grafana
sudo systemctl start grafana-server
```

Access Grafana via your browser at `http://localhost:3000` and log in using the default credentials (`admin/admin`).

### Step 2: Install and Configure node_exporter

`node_exporter` is a Prometheus exporter that collects system metrics from Linux servers, such as CPU, memory, disk usage, and network performance.

1. **Download and install node_exporter**:

```bash
wget https://github.com/prometheus/node_exporter/releases/download/v1.3.1/node_exporter-1.3.1.linux-amd64.tar.gz
tar xvfz node_exporter-1.3.1.linux-amd64.tar.gz
sudo mv node_exporter-1.3.1.linux-amd64/node_exporter /usr/local/bin/
```

2. **Start node_exporter**:

Run the `node_exporter` binary:

```bash
/usr/local/bin/node_exporter &
```

To make `node_exporter` start automatically on boot, create a systemd service file:

```bash
sudo nano /etc/systemd/system/node_exporter.service
```

Add the following content:

```ini
[Unit]
Description=Node Exporter
Wants=network-online.target
After=network-online.target

[Service]
User=node_exporter
ExecStart=/usr/local/bin/node_exporter
Restart=always

[Install]
WantedBy=default.target
```

Save the file, reload the systemd daemon, and start the service:

```bash
sudo systemctl daemon-reload
sudo systemctl start node_exporter
sudo systemctl enable node_exporter
```

### Step 3: Configure Prometheus to Scrape node_exporter

Prometheus needs to be configured to scrape metrics from the `node_exporter`. Add a job to the `prometheus.yml` configuration file:

```yaml
scrape_configs:
  - job_name: 'node_exporter'
    static_configs:
      - targets: ['localhost:9100']
```

This configures Prometheus to scrape metrics from `node_exporter` on port 9100. Restart Prometheus to apply the new configuration:

```bash
sudo systemctl restart prometheus
```

### Step 4: Visualize Linux Metrics in Grafana

Now that Prometheus is scraping metrics from `node_exporter`, you can visualize the data in Grafana.

1. **Add Prometheus as a Data Source**:

- In Grafana, go to **Configuration > Data Sources**.
- Click **Add data source**, select **Prometheus**, and enter the Prometheus URL (e.g., `http://localhost:9090`).
- Click **Save & Test** to verify the connection.

2. **Import a Linux Server Dashboard**:

Grafana has many pre-built dashboards available for monitoring Linux servers. You can import a popular one to quickly get started:

- Go to **Dashboards > Manage > Import**.
- Enter dashboard ID `1860` (or search for "Node Exporter Full").
- Click **Load**, select your Prometheus data source, and click **Import**.

This dashboard provides comprehensive monitoring of Linux system metrics, including:

- CPU usage and load averages.
- Memory usage and swap usage.
- Disk I/O and storage utilization.
- Network traffic and errors.

### Step 5: Set Up Alerts (Optional)

To proactively monitor your servers, you can set up alerts in Grafana. For example, you can create alerts for high CPU usage, low disk space, or high memory consumption.

1. **Create a new alert**:

- Go to the relevant panel (e.g., "CPU Usage") where you want to create an alert.
- Click the panel title and select **Edit**.
- Go to the **Alert** tab and set your alert conditions (e.g., CPU usage > 80%).

2. **Configure notification channels**:

- Go to **Alerting > Notification channels**.
- Add your preferred notification method (email, Slack, etc.) and link it to the alert.

### Final Thoughts

By monitoring your Linux servers with Grafana and Prometheus using `node_exporter`, you can gain real-time visibility into system performance and health. This setup helps you identify bottlenecks, prevent outages, and ensure that your servers run optimally. With powerful dashboards and alerts, you’ll always stay on top of your infrastructure's performance.
