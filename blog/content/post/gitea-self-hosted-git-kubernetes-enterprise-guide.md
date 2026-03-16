---
title: "Gitea: Self-Hosted Git Service on Kubernetes for Air-Gapped Environments"
date: 2027-01-23T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Gitea", "Git", "DevOps", "Self-Hosted"]
categories:
- DevOps
- Kubernetes
- Infrastructure
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete production guide for deploying Gitea on Kubernetes with PostgreSQL, LDAP/OIDC SSO, Gitea Actions runners, repository mirroring, and backup automation for air-gapped environments."
more_link: "yes"
url: "/gitea-self-hosted-git-kubernetes-enterprise-guide/"
---

Air-gapped environments, regulated industries, and cost-conscious engineering teams increasingly need a self-hosted Git platform that delivers GitHub-compatible workflows without the licensing costs of GitHub Enterprise or the operational weight of GitLab. **Gitea** fills this niche with a single Go binary that consumes roughly 100 MB of RAM at idle, supports GitHub Actions-compatible CI via Gitea Actions, and provides a complete API for automation. This guide covers a production-grade Kubernetes deployment with PostgreSQL, LDAP/OIDC authentication, organization management, protected branches, webhooks, and backup procedures.

<!--more-->

## Gitea vs GitLab for Small Teams and Air-Gapped Deployments

| Dimension | Gitea | GitLab CE |
|-----------|-------|-----------|
| Memory footprint (idle) | ~100 MB | 2–4 GB |
| Storage footprint | Single binary | ~2 GB container image |
| Air-gap complexity | Low (single image + DB) | High (many services) |
| CI/CD | Gitea Actions (ACT runner) | GitLab CI (built-in) |
| GitHub Actions compatibility | High (uses `act`) | Partial (different YAML) |
| Kubernetes operator | None needed | gitlab-operator |
| License | MIT | MIT Core / EE features |
| LDAP / OIDC | Yes | Yes |
| Container registry | Yes (since 1.19) | Yes |

GitLab remains the better choice for large engineering organizations that need integrated SAST, DAST, Dependency Scanning, and enterprise compliance features. For teams under 200 engineers in regulated or air-gapped environments who want GitHub Actions workflows, Gitea is consistently the pragmatic choice.

## Infrastructure Prerequisites

### PostgreSQL Deployment

Gitea works with SQLite (development only), MySQL, and PostgreSQL. PostgreSQL is strongly recommended for production.

```yaml
# postgres-gitea.yaml — simple standalone PostgreSQL for Gitea
# In production, use CloudNativePG or Crunchy Data PGO instead
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: gitea-postgres
  namespace: gitea
spec:
  serviceName: gitea-postgres
  replicas: 1
  selector:
    matchLabels:
      app: gitea-postgres
  template:
    metadata:
      labels:
        app: gitea-postgres
    spec:
      securityContext:
        runAsUser: 999
        fsGroup: 999
      containers:
        - name: postgres
          image: postgres:16.2-alpine
          env:
            - name: POSTGRES_DB
              value: gitea
            - name: POSTGRES_USER
              valueFrom:
                secretKeyRef:
                  name: gitea-postgres-secret
                  key: username
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: gitea-postgres-secret
                  key: password
            - name: PGDATA
              value: /var/lib/postgresql/data/pgdata
          ports:
            - containerPort: 5432
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
          resources:
            requests:
              cpu: 250m
              memory: 512Mi
            limits:
              cpu: "1"
              memory: 2Gi
          readinessProbe:
            exec:
              command: ["pg_isready", "-U", "gitea", "-d", "gitea"]
            initialDelaySeconds: 10
            periodSeconds: 5
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: fast-ssd
        resources:
          requests:
            storage: 50Gi
---
apiVersion: v1
kind: Service
metadata:
  name: gitea-postgres
  namespace: gitea
spec:
  selector:
    app: gitea-postgres
  ports:
    - port: 5432
      targetPort: 5432
  clusterIP: None
```

```bash
# Create the Postgres secret
kubectl create namespace gitea

kubectl create secret generic gitea-postgres-secret \
  --namespace gitea \
  --from-literal=username=gitea \
  --from-literal=password=CHANGE_ME_STRONG_PASSWORD
```

### Persistent Storage for Git Repositories

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: gitea-repositories
  namespace: gitea
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: fast-ssd
  resources:
    requests:
      storage: 200Gi
```

## Helm Deployment

```bash
helm repo add gitea-charts https://dl.gitea.com/charts/
helm repo update
```

```yaml
# gitea-values.yaml
image:
  registry: docker.io
  repository: gitea/gitea
  tag: "1.22.2"
  pullPolicy: IfNotPresent

replicaCount: 2

service:
  http:
    type: ClusterIP
    port: 3000
  ssh:
    type: LoadBalancer
    port: 22
    annotations:
      service.beta.kubernetes.io/aws-load-balancer-type: nlb

ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/proxy-body-size: "512m"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "600"
  hosts:
    - host: git.internal.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: gitea-tls
      hosts:
        - git.internal.example.com

persistence:
  enabled: true
  existingClaim: gitea-repositories
  subPath: ""

resources:
  requests:
    cpu: 500m
    memory: 512Mi
  limits:
    cpu: "2"
    memory: 2Gi

podDisruptionBudget:
  enabled: true
  minAvailable: 1

gitea:
  admin:
    username: gitea-admin
    existingSecret: gitea-admin-secret

  config:
    APP_NAME: "Internal Git Service"

    server:
      DOMAIN: git.internal.example.com
      ROOT_URL: https://git.internal.example.com/
      SSH_DOMAIN: git.internal.example.com
      SSH_PORT: 22
      LFS_START_SERVER: true
      LFS_JWT_SECRET: ""   # Set via secret

    database:
      DB_TYPE: postgres
      HOST: gitea-postgres.gitea.svc.cluster.local:5432
      NAME: gitea
      USER: gitea
      PASSWD: ""  # Set via environment variable from secret

    cache:
      ADAPTER: redis
      HOST: redis://gitea-redis.gitea.svc.cluster.local:6379/0

    session:
      PROVIDER: redis
      PROVIDER_CONFIG: "network=tcp,addr=gitea-redis.gitea.svc.cluster.local:6379,db=1"

    queue:
      TYPE: redis
      CONN_STR: "redis://gitea-redis.gitea.svc.cluster.local:6379/2"

    repository:
      DEFAULT_BRANCH: main
      DEFAULT_PRIVATE: true
      MAX_CREATION_LIMIT: -1
      FORCE_PRIVATE: false
      DEFAULT_PUSH_CREATE_PRIVATE: true

    security:
      SECRET_KEY: ""        # Set via secret
      INTERNAL_TOKEN: ""    # Set via secret
      INSTALL_LOCK: true
      MIN_PASSWORD_LENGTH: 12
      PASSWORD_COMPLEXITY: lower,upper,digit,spec

    mailer:
      ENABLED: true
      SMTP_ADDR: smtp.internal.example.com
      SMTP_PORT: 587
      FROM: "gitea@internal.example.com"
      USER: gitea-smtp
      PASSWD: ""  # Set via environment variable

    service:
      DISABLE_REGISTRATION: false
      REQUIRE_SIGNIN_VIEW: true
      ALLOW_ONLY_EXTERNAL_REGISTRATION: true  # Force SSO sign-in
      ENABLE_NOTIFY_MAIL: true
      DEFAULT_ORG_VISIBILITY: private
      DEFAULT_USER_VISIBILITY: private

    log:
      MODE: console
      LEVEL: Info
      ROOT_PATH: /data/log

    metrics:
      ENABLED: true
      TOKEN: ""  # Set via secret

  existingSecret: gitea-app-secret

postgresql:
  enabled: false  # Using external PostgreSQL

postgresql-ha:
  enabled: false

redis-cluster:
  enabled: false

redis:
  enabled: true
  architecture: standalone
  auth:
    enabled: false
  master:
    resources:
      requests:
        cpu: 100m
        memory: 128Mi
      limits:
        cpu: 500m
        memory: 256Mi
    persistence:
      size: 5Gi
```

```bash
# Create secrets referenced by the values file
kubectl create secret generic gitea-admin-secret \
  --namespace gitea \
  --from-literal=username=gitea-admin \
  --from-literal=password=CHANGE_ME_ADMIN_PASSWORD

kubectl create secret generic gitea-app-secret \
  --namespace gitea \
  --from-literal=secret_key=$(openssl rand -hex 32) \
  --from-literal=internal_token=$(openssl rand -hex 32) \
  --from-literal=lfs_jwt_secret=$(openssl rand -hex 32) \
  --from-literal=metrics_token=$(openssl rand -hex 20) \
  --from-literal=DB_PASSWD=CHANGE_ME_STRONG_PASSWORD

helm install gitea gitea-charts/gitea \
  --namespace gitea \
  --create-namespace \
  -f gitea-values.yaml
```

## LDAP Authentication

```yaml
# gitea-ldap-values.yaml — additional values for LDAP
gitea:
  ldap:
    - name: "Corporate LDAP"
      securityProtocol: starttls
      host: ldap.internal.example.com
      port: "389"
      userSearchBase: "ou=users,dc=internal,dc=example,dc=com"
      userFilter: "(&(objectClass=person)(uid=%s))"
      adminFilter: "(memberOf=cn=gitea-admins,ou=groups,dc=internal,dc=example,dc=com)"
      emailAttribute: mail
      usernameAttribute: uid
      firstnameAttribute: givenName
      surnameAttribute: sn
      publicSSHKeyAttribute: sshPublicKey
      bindDn: "cn=gitea-bind,ou=service-accounts,dc=internal,dc=example,dc=com"
      bindPassword: CHANGE_ME_LDAP_BIND_PASSWORD
      synchronizeUsers: true
      pageSize: "50"
```

## OIDC/OAuth2 Configuration

For Keycloak or any OIDC provider:

```bash
# Configure OIDC via Gitea admin panel or API
curl -s -X POST https://git.internal.example.com/api/v1/admin/oauth2 \
  -H "Authorization: token EXAMPLE_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Keycloak",
    "provider": "openidConnect",
    "client_id": "gitea",
    "client_secret": "EXAMPLE_OIDC_CLIENT_SECRET",
    "open_id_connect_auto_discovery_url": "https://keycloak.internal.example.com/realms/internal/.well-known/openid-configuration",
    "auto_register_users": true,
    "group_claim_name": "groups",
    "admin_group": "/gitea-admins",
    "restricted_group": ""
  }'
```

## Organization and Team Management

```bash
# Create an organization via API
curl -s -X POST https://git.internal.example.com/api/v1/orgs \
  -H "Authorization: token EXAMPLE_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "platform-team",
    "full_name": "Platform Engineering",
    "description": "Internal platform infrastructure repositories",
    "visibility": "private",
    "repo_admin_change_team_access": false
  }'

# Create a team within the organization
curl -s -X POST https://git.internal.example.com/api/v1/orgs/platform-team/teams \
  -H "Authorization: token EXAMPLE_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "infrastructure",
    "description": "Infrastructure repository maintainers",
    "includes_all_repositories": false,
    "permission": "write",
    "units": [
      "repo.code",
      "repo.issues",
      "repo.pulls",
      "repo.wiki"
    ]
  }'

# Add a member to the team
curl -s -X PUT "https://git.internal.example.com/api/v1/teams/1/members/alice" \
  -H "Authorization: token EXAMPLE_ADMIN_TOKEN"
```

## Protected Branches and Required Reviews

Configure branch protection via Gitea API or UI:

```bash
# Enable branch protection on 'main'
curl -s -X POST \
  "https://git.internal.example.com/api/v1/repos/platform-team/k8s-configs/branches/main/protection" \
  -H "Authorization: token EXAMPLE_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "branch_name": "main",
    "enable_push": false,
    "enable_push_whitelist": true,
    "push_whitelist_teams": ["infrastructure"],
    "require_signed_commits": true,
    "enable_status_check": true,
    "status_check_contexts": ["ci/gitea-actions"],
    "required_approvals": 2,
    "enable_approvals_whitelist": false,
    "dismiss_stale_approvals": true,
    "block_on_rejected_reviews": true,
    "block_on_outdated_branch": true,
    "require_last_commit_approval": true
  }'
```

## Gitea Actions

Gitea Actions uses the same YAML format as GitHub Actions and runs workflows via the **act_runner** (based on `nektos/act`).

### Deploying the act_runner on Kubernetes

```yaml
# gitea-runner.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: gitea-runner
  namespace: gitea
spec:
  replicas: 3
  selector:
    matchLabels:
      app: gitea-runner
  template:
    metadata:
      labels:
        app: gitea-runner
    spec:
      serviceAccountName: gitea-runner
      initContainers:
        - name: register
          image: gitea/act_runner:0.2.10
          command:
            - sh
            - -c
            - |
              if [ ! -f /data/.runner ]; then
                act_runner register \
                  --no-interactive \
                  --instance ${GITEA_INSTANCE_URL} \
                  --token ${GITEA_RUNNER_TOKEN} \
                  --name ${POD_NAME} \
                  --labels ubuntu-latest:docker://node:20-bullseye,ubuntu-22.04:docker://ubuntu:22.04
              fi
          env:
            - name: GITEA_INSTANCE_URL
              value: "http://gitea-http.gitea.svc.cluster.local:3000"
            - name: GITEA_RUNNER_TOKEN
              valueFrom:
                secretKeyRef:
                  name: gitea-runner-secret
                  key: token
            - name: POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
          volumeMounts:
            - name: runner-data
              mountPath: /data
      containers:
        - name: runner
          image: gitea/act_runner:0.2.10
          command: ["act_runner", "daemon", "--config", "/config/config.yaml"]
          env:
            - name: DOCKER_HOST
              value: "tcp://localhost:2376"
            - name: DOCKER_TLS_CERTDIR
              value: "/certs"
            - name: DOCKER_TLS_VERIFY
              value: "1"
            - name: DOCKER_CERT_PATH
              value: "/certs/client"
          volumeMounts:
            - name: runner-data
              mountPath: /data
            - name: runner-config
              mountPath: /config
            - name: docker-certs
              mountPath: /certs
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: "2"
              memory: 2Gi

        # Docker-in-Docker sidecar for running container-based jobs
        - name: dind
          image: docker:24.0-dind
          securityContext:
            privileged: true
          env:
            - name: DOCKER_TLS_CERTDIR
              value: "/certs"
          volumeMounts:
            - name: docker-certs
              mountPath: /certs
            - name: dind-storage
              mountPath: /var/lib/docker
          resources:
            requests:
              cpu: 500m
              memory: 1Gi
            limits:
              cpu: "4"
              memory: 8Gi

      volumes:
        - name: runner-data
          emptyDir: {}
        - name: runner-config
          configMap:
            name: gitea-runner-config
        - name: docker-certs
          emptyDir: {}
        - name: dind-storage
          emptyDir: {}
```

```yaml
# gitea-runner-config.yaml ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: gitea-runner-config
  namespace: gitea
data:
  config.yaml: |
    log:
      level: info
    runner:
      file: /data/.runner
      capacity: 4
      envs:
        REGISTRY: registry.internal.example.com
      timeout: 3h
      insecure: false
      fetch_timeout: 5s
      fetch_interval: 2s
    cache:
      enabled: true
      dir: /data/cache
      host: ""
      port: 0
    container:
      network: bridge
      privileged: false
      options: ""
      workdir_parent: /data/workdir
      valid_volumes:
        - /data/workdir
      docker_host: "-"
```

### Example Gitea Actions Workflow

```yaml
# .gitea/workflows/ci.yaml
name: CI

on:
  push:
    branches: [main, "release/*"]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Go
        uses: actions/setup-go@v5
        with:
          go-version: "1.22"
          cache: true

      - name: Run tests
        run: go test -race -coverprofile=coverage.out ./...

      - name: Build
        run: go build -ldflags="-s -w" -o bin/app ./cmd/app

  build-push:
    needs: test
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4

      - name: Build and push container image
        run: |
          docker build -t ${{ env.REGISTRY }}/platform-team/app:${{ github.sha }} .
          docker push ${{ env.REGISTRY }}/platform-team/app:${{ github.sha }}
```

## Repository Mirroring

Gitea can mirror from GitHub, GitLab, or any Git remote. This is essential for air-gapped environments that need to pull upstream open-source dependencies.

```bash
# Create a push mirror (mirror TO an external repo)
curl -s -X POST \
  "https://git.internal.example.com/api/v1/repos/platform-team/k8s-configs/push_mirrors" \
  -H "Authorization: token EXAMPLE_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "remote_name": "github-mirror",
    "remote_address": "https://github.com/org/k8s-configs.git",
    "remote_username": "mirror-bot",
    "remote_password": "EXAMPLE_TOKEN",
    "interval": "8h0m0s",
    "sync_on_commit": true
  }'

# Create a pull mirror (mirror FROM an external repo)
curl -s -X POST \
  "https://git.internal.example.com/api/v1/repos/migrate" \
  -H "Authorization: token EXAMPLE_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "clone_addr": "https://github.com/kubernetes/kubernetes.git",
    "repo_name": "kubernetes",
    "repo_owner": "mirrors",
    "mirror": true,
    "mirror_interval": "24h0m0s",
    "private": true,
    "description": "Upstream Kubernetes mirror"
  }'
```

## Webhook Configuration for CI/CD Triggers

```bash
# Create a webhook on a repository
curl -s -X POST \
  "https://git.internal.example.com/api/v1/repos/platform-team/app/hooks" \
  -H "Authorization: token EXAMPLE_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "gitea",
    "config": {
      "url": "https://argocd.internal.example.com/api/webhook",
      "content_type": "json",
      "secret": "EXAMPLE_WEBHOOK_SECRET"
    },
    "events": ["push", "create", "pull_request"],
    "branch_filter": "main",
    "active": true
  }'
```

## Backup and Restore

### Automated Backup CronJob

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: gitea-backup
  namespace: gitea
spec:
  schedule: "0 2 * * *"  # Daily at 02:00 UTC
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 7
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: backup
              image: gitea/gitea:1.22.2
              command:
                - sh
                - -c
                - |
                  BACKUP_FILE="/backup/gitea-dump-$(date +%Y%m%d-%H%M%S).zip"
                  gitea admin dump \
                    --config /data/gitea/conf/app.ini \
                    --file ${BACKUP_FILE} \
                    --type zip
                  # Upload to S3
                  aws s3 cp ${BACKUP_FILE} s3://gitea-backups-prod/$(basename ${BACKUP_FILE})
                  # Verify upload
                  aws s3 ls s3://gitea-backups-prod/$(basename ${BACKUP_FILE})
                  echo "Backup completed: ${BACKUP_FILE}"
              env:
                - name: AWS_DEFAULT_REGION
                  value: us-east-1
                - name: AWS_ACCESS_KEY_ID
                  valueFrom:
                    secretKeyRef:
                      name: gitea-backup-aws
                      key: access_key_id
                - name: AWS_SECRET_ACCESS_KEY
                  valueFrom:
                    secretKeyRef:
                      name: gitea-backup-aws
                      key: secret_access_key
              volumeMounts:
                - name: gitea-data
                  mountPath: /data
                - name: backup-temp
                  mountPath: /backup
          volumes:
            - name: gitea-data
              persistentVolumeClaim:
                claimName: gitea-repositories
            - name: backup-temp
              emptyDir:
                sizeLimit: 50Gi
```

### Restore Procedure

```bash
# 1. Scale down Gitea
kubectl scale deployment gitea --replicas=0 -n gitea

# 2. Download the backup
aws s3 cp s3://gitea-backups-prod/gitea-dump-20261201-020000.zip /tmp/gitea-restore.zip

# 3. Run restore in a temporary pod
kubectl run gitea-restore \
  --image=gitea/gitea:1.22.2 \
  --restart=Never \
  --namespace=gitea \
  --overrides='{"spec":{"volumes":[{"name":"data","persistentVolumeClaim":{"claimName":"gitea-repositories"}}],"containers":[{"name":"gitea-restore","image":"gitea/gitea:1.22.2","command":["sleep","3600"],"volumeMounts":[{"name":"data","mountPath":"/data"}]}]}}' \
  -n gitea

# 4. Copy restore archive into the pod and run restore
kubectl cp /tmp/gitea-restore.zip gitea/gitea-restore:/tmp/gitea-restore.zip
kubectl exec -n gitea gitea-restore -- \
  gitea admin restore --config /data/gitea/conf/app.ini --from /tmp/gitea-restore.zip

# 5. Scale Gitea back up
kubectl scale deployment gitea --replicas=2 -n gitea
kubectl delete pod gitea-restore -n gitea
```

## Monitoring with Prometheus

Gitea exposes a Prometheus metrics endpoint at `/metrics` (requires `METRICS_TOKEN` for authentication):

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: gitea
  namespace: gitea
  labels:
    release: prometheus
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: gitea
  endpoints:
    - port: http
      path: /metrics
      interval: 60s
      bearerTokenSecret:
        name: gitea-app-secret
        key: metrics_token
```

Key metrics to alert on:

```
# Active users over time
gitea_users_total

# Repository count
gitea_repositories_total

# Open issues and pull requests
gitea_issues_open_count
gitea_pulls_open_count

# HTTP request duration (P99 > 2s warrants investigation)
gitea_http_request_duration_seconds_bucket

# Database query errors
gitea_db_errors_total
```

## Migration from GitHub Enterprise

```bash
# Bulk migrate repositories from GitHub Enterprise to Gitea
# using the Gitea migration API

GITHUB_TOKEN="EXAMPLE_GITHUB_TOKEN"
GITEA_TOKEN="EXAMPLE_GITEA_TOKEN"
GITHUB_ORG="acme-corp"
GITEA_ORG="acme-corp"
GITEA_URL="https://git.internal.example.com"

# List all repos in GitHub org
gh repo list ${GITHUB_ORG} --limit 1000 --json nameWithOwner -q '.[].nameWithOwner' | \
while IFS= read -r repo; do
  repo_name=$(basename "${repo}")
  echo "Migrating ${repo_name}..."

  curl -s -X POST "${GITEA_URL}/api/v1/repos/migrate" \
    -H "Authorization: token ${GITEA_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{
      \"clone_addr\": \"https://github.com/${repo}\",
      \"auth_token\": \"${GITHUB_TOKEN}\",
      \"repo_name\": \"${repo_name}\",
      \"repo_owner\": \"${GITEA_ORG}\",
      \"mirror\": false,
      \"private\": true,
      \"description\": \"Migrated from GitHub Enterprise\",
      \"wiki\": true,
      \"issues\": true,
      \"pull_requests\": true,
      \"releases\": true,
      \"labels\": true,
      \"milestones\": true,
      \"service\": \"github\"
    }"

  sleep 2  # Respect rate limits
done
```

## Operational Considerations

### Scaling for Large Repository Counts

Git operations are CPU and disk I/O intensive. For organizations with thousands of repositories:

- Use a `ReadWriteMany` StorageClass (NFS, CephFS, or AWS EFS) if running multiple Gitea replicas that need to share the repository store.
- Alternatively, configure Gitea with a distributed object store (MinIO/S3) for LFS and attachment storage while keeping the repository data on a single `ReadWriteOnce` volume with a single Gitea pod writing to it.
- Place Redis between Gitea and PostgreSQL for session and queue buffering — this dramatically reduces database pressure during peak push activity.

### LFS Configuration

```ini
# In app.ini / values.yaml gitea.config section
[lfs]
ENABLED           = true
PATH              = /data/lfs
STORAGE_TYPE      = minio
MINIO_ENDPOINT    = minio.storage.svc.cluster.local:9000
MINIO_ACCESS_KEY_ID     = EXAMPLE_MINIO_KEY
MINIO_SECRET_ACCESS_KEY = EXAMPLE_MINIO_SECRET
MINIO_BUCKET      = gitea-lfs
MINIO_USE_SSL     = false
```

### Upgrade Procedure

```bash
# Check for pending database migrations before upgrading
kubectl exec -n gitea deploy/gitea -- gitea admin db-doctor

# Perform the upgrade (Helm)
helm upgrade gitea gitea-charts/gitea \
  --namespace gitea \
  --reuse-values \
  --set image.tag=1.22.3 \
  --wait \
  --timeout 10m

# Verify the upgrade
kubectl rollout status deployment/gitea -n gitea
kubectl exec -n gitea deploy/gitea -- gitea --version
```

Gitea's operational simplicity makes it an excellent choice for engineering teams that need a production-grade Git host without the infrastructure burden of a full GitLab deployment. The combination of Gitea Actions, repository mirroring, and a rich REST API provides all the building blocks for a complete internal developer platform in air-gapped environments.
