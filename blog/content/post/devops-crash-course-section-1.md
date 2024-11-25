---
title: "DevOps Engineer Crash Course - Section 1"
date: 2025-03-01T10:00:00-05:00
draft: false
tags: ["DevOps", "AWS", "Crash Course", "Infrastructure"]
categories:
- DevOps
- Infrastructure
author: "Matthew Mattox - mmattox@support.tools"
description: "New to DevOps? This crash course is your survival guide to understanding and managing infrastructure effectively. Learn key concepts, tools, and best practices."
more_link: "yes"
url: "/devops-crash-course-section-1/"
---

**DevOps Crash Course - Section 1: Into the Fray**

Welcome to the first installment of the DevOps Crash Course. This series is tailored for those who suddenly find themselves thrust into the world of DevOps with little to no preparation. If you’re staring at AWS credentials and wondering what to do next, this guide is for you.

---

## **A New Perspective on DevOps**

DevOps roles are often thrust upon individuals with minimal training. Whether you're coming from a development background or have been the go-to troubleshooter, this guide aims to demystify the essentials of infrastructure management.

---

## **Guiding Principles**

1. **Team Size**: Assume a team of one or two people. Focus on buying solutions rather than building them.
2. **Automation is Key**: Build systems that self-heal and require minimal intervention.
3. **Keep It Simple**: Choose boring, stable solutions over cutting-edge tech.
4. **No Gatekeeping**: Empower teams to manage their own resources.
5. **Learn As You Go**: You don’t need to be an expert in everything. Do your best, and let go of guilt.

---

## **Step 1: Snapshot the Current Infrastructure**

### **Why?**
Documenting your infrastructure is crucial for disaster recovery and preventing unauthorized changes.

### **Tool of Choice: Terraformer**
Terraformer is a Go-based CLI tool that exports existing cloud infrastructure into Terraform files.

#### **Quickstart:**
1. Install Terraformer:
   ```bash
   curl -LO https://github.com/GoogleCloudPlatform/terraformer/releases/download/0.8.15/terraformer-all-linux-amd64
   chmod +x terraformer-all-linux-amd64
   sudo mv terraformer-all-linux-amd64 /usr/local/bin/terraformer
   ```
2. Export AWS resources:
   ```bash
   terraformer import aws --regions INSERT_REGION_HERE --resources="*" --profile=production
   ```

#### **Result:**
A directory structure mapping your AWS resources is generated. Use `terraform plan` to ensure you can restore the setup if needed.

---

## **Step 2: Map Out Deployment Workflows**

Understand how code moves from repositories to production. Key areas to investigate:
- **Containerization**: Are Dockerfiles used? Where are images stored?
- **Secrets**: Are secrets managed securely (e.g., AWS Secrets Manager)?
- **Migrations**: How are database migrations handled?
- **Cron Jobs**: Are there standalone "worker" servers for background tasks?

Document these workflows for clarity and improvement opportunities.

---

## **Step 3: Log Management**

Logs are essential for debugging and monitoring. Identify:
1. **Log Generation**: Where are logs generated, and what tools manage them (e.g., syslog)?
2. **Retention**: Are logs rotated or archived properly?
3. **Developer Access**: How do developers access logs—via a web interface, CLI, or SSH?

If logs are pushed to AWS CloudWatch, verify permissions and retention settings.

---

## **Step 4: Audit SSH Access**

### **Checklist**:
- How are public keys added to servers?
- Which IPs are allowed SSH access?
- Are bastion hosts in use? How do they operate?
- What’s the process for offboarding users?

Restrict SSH access and ensure bastion hosts are up-to-date and secure.

---

## **Step 5: Set Up Basic Monitoring**

### **Health Checks**
Verify that applications are running by checking health endpoints (e.g., `/health`). Create a dashboard that visualizes uptime and functionality.

### **Tools**
- **Uptime Robot**: Monitor endpoints and set alerts.
- **Hetrix**: A free alternative for basic monitoring.

Whitelist the monitoring service IPs in your security groups for health checks.

---

## **Step 6: Run a Security Audit**

### **Tool of Choice: Prowler**
Prowler is an AWS security auditing tool that checks for compliance with CIS benchmarks.

#### **Quickstart:**
1. Clone the repo:
   ```bash
   git clone https://github.com/toniblyx/prowler
   cd prowler
   ```
2. Run the audit:
   ```bash
   ./prowler -p production -r INSERT_REGION_HERE -M html,csv -g cislevel1
   ```

#### **Deliverable**:
Save the HTML and CSV reports. Share findings with leadership to highlight security gaps.

---

## **Step 7: Diagram the Infrastructure**

A visual map of the infrastructure is invaluable for troubleshooting and planning. Use tools like:
- **Cloudmapper**: Generate detailed diagrams of AWS resources.
- **AWS Perspective**: A managed alternative for AWS users.

Ensure your diagram includes:
- Network flow and dependencies.
- Key services like databases, load balancers, and message queues.

---

## **The End Goal**

After completing these steps, you should have:
1. A Terraform-based snapshot of the infrastructure.
2. A clear understanding of deployment workflows.
3. Documented log management practices.
4. SSH access controls and security practices.
5. Basic monitoring and alerting in place.
6. A security audit report.
7. A comprehensive infrastructure diagram.

---

## **What’s Next?**

If this guide was helpful, stay tuned for future sections covering:
- Metrics and dashboards.
- DNS and email configurations.
- Managed services vs. self-hosted solutions.
- Kubernetes: When to use it and what to know.
