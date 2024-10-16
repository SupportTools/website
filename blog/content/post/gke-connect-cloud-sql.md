---
title: "How to Connect an App Running in GKE to Google Cloud SQL"
date: 2024-10-22T05:15:00-05:00
draft: false
tags: ["GKE", "Google Cloud SQL", "Kubernetes", "Cloud SQL Proxy"]
categories:
- Google Cloud
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A guide on connecting an app running in GKE to Google Cloud SQL using a Cloud SQL Proxy sidecar."
more_link: "yes"
url: "/gke-connect-cloud-sql/"
---

## How to Connect an App Running in GKE to Google Cloud SQL

Google Kubernetes Engine (GKE) and Google Cloud SQL are powerful, fully managed services provided by Google Cloud Platform. GKE handles container orchestration, while Google Cloud SQL offers managed relational databases like MySQL and PostgreSQL. Connecting an app running on GKE to a Cloud SQL instance securely is a common task in many production environments. In this guide, we’ll walk you through how to set up this connection using a **Cloud SQL Proxy sidecar container**.

<!--more-->

### Connecting an App Running in GKE to Cloud SQL Using a Proxy Sidecar

In this architecture, your app runs inside a GKE pod that also includes a **Cloud SQL Proxy** sidecar container. The proxy handles secure connections and authentication between your app and the Cloud SQL instance. This method ensures that your database credentials and communication are secure and encrypted.

### Step 1: Create a Cloud SQL Instance

First, create a Cloud SQL instance on Google Cloud:

1. Go to the [Google Cloud Console](https://console.cloud.google.com/sql/instances).
2. Create a new Cloud SQL instance, choosing the appropriate **database engine** (MySQL or PostgreSQL), **region**, and **authorized networks**.
3. Configure your database version and settings.

Ensure that your GKE cluster has network access to the Cloud SQL instance by authorizing the appropriate IP ranges.

### Step 2: Create a Kubernetes Secret for Database Credentials

You need to store your Cloud SQL credentials securely in GKE. To do this, create a Kubernetes secret that contains your database credentials (username and password):

```bash
kubectl create secret generic cloudsql-credentials \
  --from-literal=username=<DB_USER> \
  --from-literal=password=<DB_PASSWORD>
```

This secret will be referenced in your deployment manifest to supply the app with the necessary credentials.

### Step 3: Configure the Cloud SQL Proxy Sidecar

To establish the connection between your GKE app and the Cloud SQL instance, you need to include the **Cloud SQL Proxy** as a sidecar container in your app’s pod. This proxy will handle authentication and encryption.

Here is an example **YAML** file for a Kubernetes deployment:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp
spec:
  selector:
    matchLabels:
      app: myapp
  template:
    metadata:
      labels:
        app: myapp
    spec:
      containers:
      - name: myapp
        image: myapp:latest
        env:
        - name: DB_HOST
          value: "/cloudsql/myproject:us-central1:myinstance"
        - name: DB_USER
          valueFrom:
            secretKeyRef:
              name: cloudsql-credentials
              key: username
        - name: DB_PASSWORD
          valueFrom:
            secretKeyRef:
              name: cloudsql-credentials
              key: password
        ports:
        - containerPort: 8080
      - name: cloudsql-proxy
        image: gcr.io/cloudsql-docker/gce-proxy:1.17
        command: ["/cloud_sql_proxy",
                  "-instances=myproject:us-central1:myinstance=tcp:3306",
                  "-credential_file=/secrets/cloudsql/credentials.json"]
        volumeMounts:
        - name: cloudsql-credentials
          mountPath: /secrets/cloudsql
          readOnly: true
      volumes:
      - name: cloudsql-credentials
        secret:
          secretName: cloudsql-credentials
```

### Explanation

1. **DB_HOST Environment Variable:** Points to the Cloud SQL instance (`/cloudsql/myproject:us-central1:myinstance`).
2. **DB_USER and DB_PASSWORD Environment Variables:** Populated from the Kubernetes secret (`cloudsql-credentials`) containing your database credentials.
3. **Cloud SQL Proxy Sidecar:** Runs the `gce-proxy` in the same pod as your application. It establishes a secure connection to your Cloud SQL instance using the `tcp:3306` configuration.
4. **Volume Mount:** The `cloudsql-credentials` secret is mounted into the container to provide access to the `credentials.json` file required by the proxy.

### Step 4: Allow Connections from GKE to Cloud SQL

Ensure that the Cloud SQL instance is configured to allow connections from your GKE cluster. You can authorize your GKE cluster’s IP range by:

1. Navigating to the **Cloud SQL** instance in the Google Cloud Console.
2. Under the **Connections** tab, add the IP range of your GKE cluster or VPC network to the **Authorized Networks** section.

### Step 5: Deploy the Application

Apply the deployment YAML to your GKE cluster using the following command:

```bash
kubectl apply -f myapp-deployment.yaml
```

Verify that the deployment and pod are running:

```bash
kubectl get pods
```

### Step 6: Test the Connection

Once your app is deployed, test the database connection. You can use tools like the MySQL or PostgreSQL command-line client to verify that the application can connect to the Cloud SQL instance.

For example, using MySQL client from within the pod:

```bash
kubectl exec -it <pod-name> -- mysql -h 127.0.0.1 -u $DB_USER -p$DB_PASSWORD
```

### Conclusion

By using the Cloud SQL Proxy sidecar container, you can securely connect your app running in GKE to a Cloud SQL instance. This approach leverages the Cloud SQL Proxy to manage authentication and encryption, ensuring that your database connection is both secure and performant.
