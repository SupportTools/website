---
title: "How to Set Up Promtail in Ubuntu 20.04"
date: 2024-12-11T12:00:00-05:00
draft: false
tags: ["Promtail", "Loki", "Grafana", "Ubuntu", "Log Monitoring", "DevOps"]
categories:
- Log Monitoring
- DevOps
author: "Matthew Mattox"
description: "A step-by-step guide to setting up Promtail on Ubuntu 20.04 for log aggregation with Grafana and Loki."
more_link: "yes"
url: "/setup-promtail-ubuntu-20-04/"
---

# How to Set Up Promtail in Ubuntu 20.04

Promtail is an essential tool for shipping logs from your applications to a Loki instance. When integrated with Grafana, it enables seamless log aggregation and monitoring. This guide walks you through installing and configuring Promtail on Ubuntu 20.04.

---

## **Prerequisites**
1. Loki and Grafana are already configured.
2. A running application to monitor (e.g., NGINX in this example).

---

## **Step 1: Install Promtail**

1. **Check Your CPU Architecture:**
   ```bash
   uname -a
   ```

2. **Download the Promtail Binary:**
   Replace `amd64` with your system's architecture if different.
   ```bash
   curl -O -L "https://github.com/grafana/loki/releases/download/v2.4.1/promtail-linux-amd64.zip"
   ```

3. **Extract and Make Executable:**
   ```bash
   unzip "promtail-linux-amd64.zip"
   chmod a+x "promtail-linux-amd64"
   ```

4. **Move Binary to System Path:**
   ```bash
   sudo cp promtail-linux-amd64 /usr/local/bin/promtail
   ```

5. **Verify Installation:**
   ```bash
   promtail --version
   ```

---

## **Step 2: Configure Promtail**

1. **Create Configuration Directory:**
   ```bash
   sudo mkdir -p /etc/promtail /etc/promtail/logs
   ```

2. **Download Example Configuration File:**
   This example config is optimized for NGINX logs.
   ```bash
   sudo curl -o /etc/promtail/promtail-config.yaml -L "https://gist.githubusercontent.com/theLazyCat775/6fe9125e529221166e9f02b00244638a/raw/84f510e6f62d0e60ab95dbe7f9732a629a27eb6d/promtail-config.yaml"
   ```

---

## **Step 3: Run Promtail as a Service**

1. **Create a Systemd Service File:**
   ```bash
   sudo vi /etc/systemd/system/promtail.service
   ```

   Add the following content:
   ```ini
   [Unit]
   Description=Promtail service
   After=network.target

   [Service]
   Type=simple
   User=root
   ExecStart=/usr/local/bin/promtail -config.file /etc/promtail/promtail-config.yaml
   Restart=on-failure
   RestartSec=20
   StandardOutput=append:/etc/promtail/logs/promtail.log
   StandardError=append:/etc/promtail/logs/promtail.log

   [Install]
   WantedBy=multi-user.target
   ```

2. **Enable and Start the Service:**
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl start promtail
   sudo systemctl status promtail
   ```

3. **Enable Service on Boot:**
   ```bash
   sudo systemctl enable promtail.service
   ```

---

## **Step 4: Verify Logs**

Check Promtail logs to ensure it is shipping logs to the Loki instance:
```bash
sudo tail -f /etc/promtail/logs/promtail.log
```

---

## **Conclusion**

Promtail is now successfully installed and running as a service on Ubuntu 20.04. It is actively monitoring your application (NGINX in this case) and shipping logs to Loki for aggregation. Pair it with Grafana for powerful visualization and monitoring.

---

**Need More Help?**
If you encounter issues or have specific requirements, feel free to reach out in the comments or connect on [Twitter](https://twitter.com/mmattox).
