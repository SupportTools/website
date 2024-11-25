---
title: "DevOps Crash Course - Section 2: Servers"
date: 2025-03-10T10:00:00-05:00
draft: false
tags: ["DevOps", "AWS", "Servers", "Containers", "Infrastructure"]
categories:
- DevOps
- Infrastructure
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn the fundamentals of managing servers in DevOps environments, from configuration drift to containerization, in this in-depth crash course section."
more_link: "yes"
url: "/devops-crash-course-section-2/"
---

**Welcome to Section 2 of the DevOps Crash Course!**  

If you’re just joining us, check out [Section 1 here](#). In this part, we’ll dive into server management, tackling the critical aspects of server reliability, configuration drift, and modern solutions like containerization.

---

## **What Matters When Managing Servers?**

Before choosing how to manage your servers, ask yourself:
1. Can we automatically provision and deploy code to new servers?
2. Is there a way to replicate production environments for testing?
3. Can we detect and replace unhealthy servers without human intervention?

---

## **What Do We Mean by "Servers"?**

While "server" traditionally referred to physical hardware, modern servers are often virtual machines (like EC2 instances). However, the definition expands to include:
- **Containers**: Lightweight processes with isolated environments.
- **Serverless Architectures**: Fully managed services like AWS Lambda.

In this section, we’ll primarily focus on **EC2 instances** as the building blocks of server infrastructure.

---

## **A Common Legacy Stack**

A typical stack for organizations with legacy setups looks like this:
1. **DNS**: Points to a classic load balancer for SSL termination.
2. **App Servers**: Handle traffic on port 80, often running Nginx and uWSGI.
3. **Databases**: Typically MySQL, either managed or self-hosted.
4. **Deployment**: Manual or semi-automated processes using zipped directories or scripts.
5. **Load Balancer Scripts**: To add/remove servers during deployments.

---

## **Why Modernize?**

### **1. Configuration Drift**
Servers manually updated over time develop unique configurations, leading to:
- Unpredictable behavior.
- Inconsistent environments between staging and production.
- Debugging nightmares during outages.

### **2. Deployment Challenges**
Legacy deployments often rely on fragile scripts that fail to scale, making rollbacks or forward fixes complex.

### **3. Testing Inefficiencies**
Without an environment mirroring production, bugs often go undetected until deployment.

---

## **Containers: A Better Way**

Containers encapsulate your application and its dependencies, ensuring consistent behavior across environments.

### **Benefits**
- **Reproducibility**: Containers eliminate "it works on my machine" problems.
- **Simplified Testing**: Developers can test in production-like environments locally.
- **Faster Deployments**: Containers are lightweight and quick to spin up.

---

## **How to Containerize Your Application**

1. **Document Current Setup**:
   Sit with the team and document the steps to get the app running on a clean server.

2. **Create a Dockerfile**:
   Translate these steps into a `Dockerfile`.

---

### **Anatomy of a Dockerfile**
Here’s a basic Dockerfile:
```dockerfile
FROM debian:bullseye
COPY . /app
RUN apt-get update && \
    apt-get install -y nodejs npm && \
    npm install --prefix /app
WORKDIR /app
CMD ["npm", "start"]
```

### **Key Instructions**
- **FROM**: Sets the base image (e.g., Debian).
- **COPY**: Copies files into the container.
- **RUN**: Executes commands to set up the environment.
- **WORKDIR**: Sets the working directory for subsequent commands.
- **CMD**: Specifies the default command to run the container.

---

## **Avoid Common Dockerfile Pitfalls**
1. Use specific image tags or SHAs instead of `latest` for consistency.
2. Consolidate `RUN` commands to optimize layers and caching.
3. Avoid running as `root`. Create a dedicated user for your app:
   ```dockerfile
   RUN useradd -m appuser
   USER appuser
   ```

---

## **Deploying Containers**

### **Option 1: EC2 Instances**
- Use tools like **Packer** to create AMIs with Docker pre-installed.
- Pull and run containers on instances.

### **Option 2: AWS Elastic Beanstalk**
- Simplifies setup with managed load balancers, scaling, and health checks.
- Ideal for simple applications but limited for complex use cases.

### **Option 3: AWS ECS (Elastic Container Service)**
- Deep integration with AWS resources.
- Offers both serverless (Fargate) and EC2-based deployment options.

### **Option 4: Kubernetes**
- Powerful but complex. Best suited for organizations with dedicated DevOps teams.

---

## **Next Steps**
1. **Logging and Metrics**: Learn to monitor your applications effectively.
2. **Database Management**: Explore options for scaling and securing databases.
3. **Serverless Options**: Understand when and how to use Lambda.
4. **IAM**: Implement robust access control policies.
