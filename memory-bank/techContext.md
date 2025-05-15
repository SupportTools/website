# Technical Context: SupportTools Website

## Technologies Used

### Frontend
- **Hugo**: Static site generator for the blog portion
- **Markdown**: Content authoring format
- **HTML/CSS/JS**: Standard web technologies

### Backend/Infrastructure
- **Go**: Backend programming language for the main application
- **Docker**: Containerization for consistent deployment
- **Kubernetes**: Container orchestration (indicated by ArgoCD configs)
- **ArgoCD**: GitOps-based deployment to Kubernetes
- **Nginx**: Web server configuration present
- **Wasabi**: Cloud storage provider used for CDN asset hosting

## Development Setup
- Source code stored in GitHub repository
- Local development likely uses Hugo's development server
- Docker build process for containerization
- `build-docker-images.sh` script for container image creation

## Technical Constraints
- Static site generation limitations
- Image optimization for CDN delivery
- Kubernetes deployment considerations
- Container size and performance optimization
- CDN synchronization timing with deployments

## Dependencies
- Go dependencies managed through go.mod
- Hugo theme dependencies (using theme m10c)
- Container base images
- Kubernetes infrastructure dependencies
- AWS CLI for Wasabi S3 compatibility

## Infrastructure Setup
### Hosting
- Appears to be using Kubernetes (ArgoCD configurations present)
- Multiple environments defined: dev, tst, qas, stg, prd
- CDN setup for static assets at cdn.support.tools
- Wasabi cloud storage (s3.us-central-1.wasabisys.com) hosts the CDN content

### CI/CD
- Deployment uses GitHub Actions workflow (`pipeline.yml`)
- ArgoCD for GitOps deployments to Kubernetes clusters
- `deploy.sh` script suggests automated deployment process
- Build process includes Docker image creation
- Multiple Kubernetes environments with dedicated configurations
- CDN synchronization with Wasabi via GitHub Actions:
  - Standalone workflow (`wasabi-sync.yml`) for manual syncs
  - Integrated CDN sync job in main pipeline for production environments
  - AWS S3 sync command used with Wasabi endpoint for compatibility

## Domain Structure
- Main site: support.tools
- CDN: cdn.support.tools

## Cloud Services
- Wasabi S3-compatible storage:
  - Bucket name: cdn.support.tools
  - Endpoint: s3.us-central-1.wasabisys.com (regional endpoint)
  - AWS region: us-central-1
  - Authentication: Using environment variables for AWS CLI
  - Credentials: Stored securely in GitHub Secrets (WASABI_ACCESS_KEY, WASABI_SECRET_KEY)
  - AWS CLI: Freshly installed in workflow to ensure compatibility
  - Sync strategy: Additive-only (no file deletion)
