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

## Dependencies
- Go dependencies managed through go.mod
- Hugo theme dependencies (using theme m10c)
- Container base images
- Kubernetes infrastructure dependencies

## Infrastructure Setup
### Hosting
- Appears to be using Kubernetes (ArgoCD configurations present)
- Multiple environments defined: dev, tst, qas, stg, prd
- CDN setup for static assets at cdn.support.tools

### CI/CD
- Deployment appears to use ArgoCD for GitOps workflows
- `deploy.sh` script suggests automated deployment process
- Build process includes Docker image creation
- Multiple Kubernetes environments with dedicated configurations

## Domain Structure
- Main site: support.tools
- CDN: cdn.support.tools
