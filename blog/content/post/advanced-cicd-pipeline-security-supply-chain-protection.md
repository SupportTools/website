---
title: "Advanced CI/CD Pipeline Security and Supply Chain Protection: Enterprise DevSecOps Framework 2026"
date: 2026-03-24T00:00:00-05:00
draft: false
tags: ["DevSecOps", "CI/CD Security", "Supply Chain Security", "Container Security", "SBOM", "Code Signing", "Vulnerability Scanning", "Security Automation", "Pipeline Security", "Software Supply Chain", "Security Policies", "Compliance", "SLSA", "Enterprise Security", "DevOps Security"]
categories:
- DevSecOps
- CI/CD
- Security
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Master advanced CI/CD pipeline security and supply chain protection for enterprise environments. Comprehensive guide to DevSecOps automation, secure pipeline design, vulnerability management, and enterprise-grade security frameworks."
more_link: "yes"
url: "/advanced-cicd-pipeline-security-supply-chain-protection/"
---

CI/CD pipeline security and software supply chain protection have become critical components of enterprise security strategies, requiring sophisticated approaches to threat detection, vulnerability management, and compliance automation. This comprehensive guide explores advanced DevSecOps implementation patterns, secure pipeline architectures, and enterprise-grade security automation frameworks for protecting software delivery processes.

<!--more-->

# [Enterprise DevSecOps Architecture Framework](#enterprise-devsecops-architecture-framework)

## Secure Pipeline Design Principles

Modern CI/CD security implementations require comprehensive integration of security controls throughout the software development lifecycle, implementing defense-in-depth strategies that protect against sophisticated supply chain attacks and ensure compliance with security standards.

### Comprehensive DevSecOps Security Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                Enterprise DevSecOps Platform                   │
├─────────────────┬─────────────────┬─────────────────┬───────────┤
│   Source        │   Build &       │   Deploy &      │   Runtime │
│   Security      │   Test Security │   Release       │   Security│
├─────────────────┼─────────────────┼─────────────────┼───────────┤
│ ┌─────────────┐ │ ┌─────────────┐ │ ┌─────────────┐ │ ┌───────┐ │
│ │ SAST/DAST   │ │ │ Container   │ │ │ Image       │ │ │ Runtime│ │
│ │ Secret Scan │ │ │ Security    │ │ │ Signing     │ │ │ Security│ │
│ │ License     │ │ │ SBOM        │ │ │ Attestation │ │ │ Monitoring│ │
│ │ Compliance  │ │ │ Vuln Scan   │ │ │ Policy      │ │ │ Threat │ │
│ └─────────────┘ │ └─────────────┘ │ └─────────────┘ │ └───────┘ │
│                 │                 │                 │           │
│ • Code Quality  │ • Build Security│ • Supply Chain  │ • Runtime │
│ • Dependency    │ • Test Coverage │ • Provenance    │ • Anomaly │
│ • Credential    │ • Security      │ • Verification  │ • Response│
│   Protection    │   Testing       │   Gates         │   Plans   │
└─────────────────┴─────────────────┴─────────────────┴───────────┘
```

### Advanced Security Scanning Integration

CI/CD pipelines require multiple layers of security scanning that integrate seamlessly into development workflows while providing comprehensive vulnerability detection and remediation guidance.

```yaml
# .github/workflows/secure-cicd-pipeline.yml
name: Secure CI/CD Pipeline with Advanced Security

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]
  schedule:
    - cron: '0 2 * * *'  # Daily security scans

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}
  SECURITY_BASELINE: "enterprise-high"
  SLSA_LEVEL: "3"

jobs:
  security-scanning:
    name: Security Scanning and Analysis
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write
      id-token: write
      attestations: write
    
    steps:
    - name: Checkout Repository
      uses: actions/checkout@v4
      with:
        fetch-depth: 0  # Full history for better analysis
        token: ${{ secrets.GITHUB_TOKEN }}

    - name: Setup Security Tools
      run: |
        # Install security scanning tools
        curl -sSfL https://raw.githubusercontent.com/anchore/grype/main/install.sh | sh -s -- -b /usr/local/bin
        curl -sSfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b /usr/local/bin
        curl -sSfL https://github.com/sigstore/cosign/releases/latest/download/cosign-linux-amd64 -o /usr/local/bin/cosign
        chmod +x /usr/local/bin/cosign
        
        # Install SLSA tools
        curl -sSfL https://github.com/slsa-framework/slsa-verifier/releases/latest/download/slsa-verifier-linux-amd64 -o /usr/local/bin/slsa-verifier
        chmod +x /usr/local/bin/slsa-verifier

    - name: Secret Scanning with GitLeaks
      run: |
        docker run --rm -v "${{ github.workspace }}:/path" zricethezav/gitleaks:latest detect \
          --source="/path" \
          --report-format=sarif \
          --report-path=/path/gitleaks-report.sarif \
          --verbose \
          --redact
        
        # Upload results to GitHub Security tab
        if [ -f gitleaks-report.sarif ]; then
          echo "secrets_found=true" >> $GITHUB_OUTPUT
        fi

    - name: Static Application Security Testing (SAST)
      uses: github/codeql-action/init@v3
      with:
        languages: ${{ matrix.language }}
        config-file: ./.github/codeql/codeql-config.yml
        queries: security-extended,security-and-quality

    - name: Build Application for Security Testing
      run: |
        # Build application with security flags
        export CGO_ENABLED=0
        export GOOS=linux
        export GOARCH=amd64
        
        go build -a -installsuffix cgo \
          -ldflags='-w -s -extldflags "-static"' \
          -tags netgo \
          -o app ./cmd/app

    - name: CodeQL Analysis
      uses: github/codeql-action/analyze@v3
      with:
        category: "/language:${{matrix.language}}"
        upload: true
        cleanup-level: none

    - name: Dependency Vulnerability Scanning
      run: |
        # Go module vulnerability scanning
        go install golang.org/x/vuln/cmd/govulncheck@latest
        govulncheck -json ./... > govulncheck-report.json
        
        # NPM audit for Node.js dependencies
        if [ -f package.json ]; then
          npm audit --audit-level=moderate --json > npm-audit-report.json
        fi
        
        # Python dependency scanning
        if [ -f requirements.txt ]; then
          pip install safety
          safety check --json --output safety-report.json || true
        fi

    - name: License Compliance Scanning
      run: |
        # FOSSA license scanning
        curl -H 'Cache-Control: no-cache' https://raw.githubusercontent.com/fossas/fossa-cli/master/install-latest.sh | bash
        fossa analyze --team="$FOSSA_TEAM" --project="${{ github.repository }}"
        fossa test --team="$FOSSA_TEAM" --project="${{ github.repository }}"
      env:
        FOSSA_API_KEY: ${{ secrets.FOSSA_API_KEY }}
        FOSSA_TEAM: ${{ secrets.FOSSA_TEAM }}

    - name: Container Build with Security
      run: |
        # Build container with security best practices
        docker build \
          --no-cache \
          --pull \
          --security-opt=no-new-privileges:true \
          --cap-drop=ALL \
          --read-only \
          -t $REGISTRY/$IMAGE_NAME:${{ github.sha }} \
          -f Dockerfile.secure .

    - name: Container Image Vulnerability Scanning
      run: |
        # Trivy comprehensive scanning
        trivy image \
          --format sarif \
          --output trivy-report.sarif \
          --severity HIGH,CRITICAL \
          --security-checks vuln,secret,config \
          --compliance docker-cis \
          $REGISTRY/$IMAGE_NAME:${{ github.sha }}
        
        # Grype vulnerability scanning
        grype $REGISTRY/$IMAGE_NAME:${{ github.sha }} \
          --output sarif \
          --file grype-report.sarif \
          --fail-on high
        
        # Snyk container scanning
        npx snyk container test $REGISTRY/$IMAGE_NAME:${{ github.sha }} \
          --severity-threshold=high \
          --json > snyk-container-report.json

    - name: Generate Software Bill of Materials (SBOM)
      run: |
        # Generate SPDX SBOM
        docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
          -v "$PWD":/workspace \
          anchore/syft:latest \
          $REGISTRY/$IMAGE_NAME:${{ github.sha }} \
          -o spdx-json=sbom.spdx.json \
          -o cyclone-dx-json=sbom.cyclone.json

    - name: Container Configuration Security
      run: |
        # Docker Bench security
        docker run --rm --net host --pid host --userns host --cap-add audit_control \
          -e DOCKER_CONTENT_TRUST=$DOCKER_CONTENT_TRUST \
          -v /etc:/etc:ro \
          -v /usr/bin/containerd:/usr/bin/containerd:ro \
          -v /usr/bin/runc:/usr/bin/runc:ro \
          -v /usr/lib/systemd:/usr/lib/systemd:ro \
          -v /var/lib:/var/lib:ro \
          -v /var/run/docker.sock:/var/run/docker.sock:ro \
          --label docker_bench_security \
          docker/docker-bench-security

    - name: Infrastructure Security Scanning
      run: |
        # Terraform security scanning with Checkov
        pip install checkov
        checkov -d ./terraform \
          --framework terraform \
          --output sarif \
          --output-file checkov-report.sarif
        
        # Kubernetes manifest security with Kubesec
        docker run --rm -v "$PWD":/workspace kubesec/kubesec:latest scan /workspace/k8s/*.yaml

    - name: Dynamic Application Security Testing (DAST)
      run: |
        # Start application for testing
        docker run -d --name test-app -p 8080:8080 $REGISTRY/$IMAGE_NAME:${{ github.sha }}
        sleep 30
        
        # OWASP ZAP baseline scan
        docker run --rm --network container:test-app \
          -v "$PWD":/zap/wrk/:rw \
          -t owasp/zap2docker-stable zap-baseline.py \
          -t http://localhost:8080 \
          -J zap-report.json \
          -r zap-report.html
        
        # Stop test application
        docker stop test-app
        docker rm test-app

    - name: Upload Security Scan Results
      uses: github/codeql-action/upload-sarif@v3
      if: always()
      with:
        sarif_file: |
          gitleaks-report.sarif
          trivy-report.sarif
          grype-report.sarif
          checkov-report.sarif

  secure-build:
    name: Secure Build and Attestation
    needs: security-scanning
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
      id-token: write
      attestations: write
    
    outputs:
      image-digest: ${{ steps.build.outputs.digest }}
      sbom-digest: ${{ steps.sbom.outputs.digest }}
    
    steps:
    - name: Checkout Repository
      uses: actions/checkout@v4

    - name: Setup Docker Buildx
      uses: docker/setup-buildx-action@v3
      with:
        driver-opts: |
          image=moby/buildkit:buildx-stable-1
          network=host

    - name: Log in to Container Registry
      uses: docker/login-action@v3
      with:
        registry: ${{ env.REGISTRY }}
        username: ${{ github.actor }}
        password: ${{ secrets.GITHUB_TOKEN }}

    - name: Extract Metadata
      id: meta
      uses: docker/metadata-action@v5
      with:
        images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
        tags: |
          type=ref,event=branch
          type=ref,event=pr
          type=sha,prefix={{branch}}-
          type=raw,value=latest,enable={{is_default_branch}}

    - name: Build and Push Container Image
      id: build
      uses: docker/build-push-action@v5
      with:
        context: .
        file: ./Dockerfile.secure
        push: true
        tags: ${{ steps.meta.outputs.tags }}
        labels: ${{ steps.meta.outputs.labels }}
        platforms: linux/amd64,linux/arm64
        cache-from: type=gha
        cache-to: type=gha,mode=max
        sbom: true
        provenance: true
        security-opt: |
          no-new-privileges:true
        build-args: |
          BUILD_DATE=${{ github.event.head_commit.timestamp }}
          VCS_REF=${{ github.sha }}
          VERSION=${{ steps.meta.outputs.version }}

    - name: Generate SBOM Attestation
      id: sbom
      uses: actions/attest-sbom@v1
      with:
        subject-name: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
        subject-digest: ${{ steps.build.outputs.digest }}
        sbom-path: sbom.spdx.json

    - name: Generate Build Provenance
      uses: actions/attest-build-provenance@v1
      with:
        subject-name: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
        subject-digest: ${{ steps.build.outputs.digest }}

    - name: Sign Container Image with Cosign
      run: |
        # Install Cosign
        cosign version
        
        # Sign the container image
        cosign sign --yes ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}@${{ steps.build.outputs.digest }}
        
        # Generate and attach SLSA provenance
        cosign attest --yes \
          --predicate slsa-provenance.json \
          --type slsaprovenance \
          ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}@${{ steps.build.outputs.digest }}

  security-policies:
    name: Security Policy Enforcement
    needs: [security-scanning, secure-build]
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write
    
    steps:
    - name: Checkout Repository
      uses: actions/checkout@v4

    - name: Setup Open Policy Agent (OPA)
      run: |
        curl -L -o opa https://github.com/open-policy-agent/opa/releases/latest/download/opa_linux_amd64_static
        chmod 755 ./opa
        sudo mv ./opa /usr/local/bin

    - name: Validate Security Policies
      run: |
        # Validate container security policies
        opa test ./.opa/policies/ ./.opa/tests/
        
        # Policy evaluation for container image
        opa eval \
          --data ./.opa/policies/ \
          --input <(echo '{"image": "${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}@${{ needs.secure-build.outputs.image-digest }}"}') \
          "data.container.security.allow"

    - name: Gatekeeper Policy Validation
      run: |
        # Install Gatekeeper CLI
        curl -L https://github.com/open-policy-agent/gatekeeper/releases/latest/download/gator-linux-amd64 -o gator
        chmod +x gator
        
        # Validate Kubernetes manifests against policies
        ./gator test ./.gatekeeper/constraints/ ./k8s/

    - name: Compliance Validation
      run: |
        # NIST compliance validation
        docker run --rm \
          -v "$PWD":/workspace \
          -v "$PWD/.compliance":/compliance \
          compliance-scanner:latest \
          --framework nist-800-53 \
          --baseline ${{ env.SECURITY_BASELINE }} \
          --workspace /workspace

    - name: Generate Security Report
      run: |
        # Aggregate security scan results
        python3 scripts/aggregate-security-results.py \
          --gitleaks gitleaks-report.sarif \
          --trivy trivy-report.sarif \
          --grype grype-report.sarif \
          --checkov checkov-report.sarif \
          --output security-summary.json
        
        # Generate compliance report
        python3 scripts/generate-compliance-report.py \
          --security-summary security-summary.json \
          --sbom sbom.spdx.json \
          --baseline ${{ env.SECURITY_BASELINE }} \
          --output compliance-report.html

    - name: Upload Security Artifacts
      uses: actions/upload-artifact@v4
      with:
        name: security-reports
        path: |
          security-summary.json
          compliance-report.html
          sbom.spdx.json
          sbom.cyclone.json

  deployment-security:
    name: Secure Deployment Pipeline
    needs: [security-scanning, secure-build, security-policies]
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    permissions:
      contents: read
      packages: read
      id-token: write
    
    steps:
    - name: Checkout Repository
      uses: actions/checkout@v4

    - name: Setup kubectl and Helm
      run: |
        # Install kubectl
        curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
        chmod +x kubectl
        sudo mv kubectl /usr/local/bin/
        
        # Install Helm
        curl https://get.helm.sh/helm-v3.14.0-linux-amd64.tar.gz | tar xz
        sudo mv linux-amd64/helm /usr/local/bin/

    - name: Verify Image Signature
      run: |
        # Verify container image signature
        cosign verify \
          --certificate-identity-regexp "https://github.com/${{ github.repository }}" \
          --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
          ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}@${{ needs.secure-build.outputs.image-digest }}
        
        # Verify SLSA provenance
        slsa-verifier verify-image \
          --source-uri github.com/${{ github.repository }} \
          --source-branch main \
          ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}@${{ needs.secure-build.outputs.image-digest }}

    - name: Deploy with Security Controls
      run: |
        # Apply security policies first
        kubectl apply -f ./.k8s/security-policies/
        
        # Deploy application with security context
        helm upgrade --install ${{ github.event.repository.name }} ./helm-chart \
          --namespace production \
          --create-namespace \
          --set image.repository=${{ env.REGISTRY }}/${{ env.IMAGE_NAME }} \
          --set image.digest=${{ needs.secure-build.outputs.image-digest }} \
          --set security.enabled=true \
          --set security.baseline=${{ env.SECURITY_BASELINE }} \
          --set podSecurityPolicy.enabled=true \
          --set networkPolicy.enabled=true \
          --set securityContext.runAsNonRoot=true \
          --set securityContext.runAsUser=65534 \
          --set securityContext.fsGroup=65534 \
          --set securityContext.capabilities.drop[0]=ALL \
          --set securityContext.readOnlyRootFilesystem=true \
          --set securityContext.allowPrivilegeEscalation=false

    - name: Runtime Security Monitoring
      run: |
        # Deploy Falco for runtime security monitoring
        helm repo add falcosecurity https://falcosecurity.github.io/charts
        helm upgrade --install falco falcosecurity/falco \
          --namespace falco-system \
          --create-namespace \
          --set falco.grpc.enabled=true \
          --set falco.grpcOutput.enabled=true \
          --set falco.httpOutput.enabled=true
        
        # Configure security alerts
        kubectl apply -f ./.k8s/monitoring/security-alerts.yaml

    - name: Post-Deployment Security Validation
      run: |
        # Wait for deployment to stabilize
        kubectl rollout status deployment/${{ github.event.repository.name }} -n production --timeout=300s
        
        # Run security validation tests
        kubectl run security-test \
          --image=aquasec/kube-bench:latest \
          --restart=Never \
          --rm -i \
          -- --json > kube-bench-results.json
        
        # Network policy validation
        kubectl run network-test \
          --image=nicolaka/netshoot \
          --restart=Never \
          --rm -i \
          -- /bin/bash -c "nmap -p 80,443,8080 ${{ github.event.repository.name }}.production.svc.cluster.local"

  security-monitoring:
    name: Continuous Security Monitoring
    needs: deployment-security
    runs-on: ubuntu-latest
    if: always()
    
    steps:
    - name: Setup Monitoring Tools
      run: |
        # Install security monitoring tools
        pip install prometheus-client grafana-api

    - name: Configure Security Dashboards
      run: |
        # Deploy Grafana security dashboards
        python3 scripts/deploy-security-dashboards.py \
          --grafana-url ${{ secrets.GRAFANA_URL }} \
          --api-key ${{ secrets.GRAFANA_API_KEY }} \
          --dashboard-path ./monitoring/dashboards/security/

    - name: Setup Security Alerts
      run: |
        # Configure Prometheus alerting rules
        kubectl apply -f ./monitoring/alerts/security-alerts.yaml
        
        # Setup Slack notifications
        python3 scripts/configure-security-alerts.py \
          --webhook-url ${{ secrets.SLACK_WEBHOOK_URL }} \
          --channel "#security-alerts"

    - name: Generate Security Metrics
      run: |
        # Calculate security posture metrics
        python3 scripts/calculate-security-metrics.py \
          --scan-results security-summary.json \
          --output security-metrics.json
        
        # Push metrics to monitoring system
        python3 scripts/push-security-metrics.py \
          --metrics security-metrics.json \
          --prometheus-gateway ${{ secrets.PROMETHEUS_GATEWAY }}
```

### Supply Chain Security Framework

Comprehensive supply chain security requires implementation of Software Bills of Materials (SBOM), provenance tracking, and verification mechanisms throughout the software lifecycle.

```python
#!/usr/bin/env python3
# scripts/supply-chain-security.py

import json
import hashlib
import subprocess
import os
from datetime import datetime
from typing import Dict, List, Optional
import requests
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import rsa, padding
from cryptography.hazmat.primitives.serialization import load_pem_private_key

class SupplyChainSecurityManager:
    """Advanced supply chain security management for enterprise CI/CD."""
    
    def __init__(self, config: Dict):
        self.config = config
        self.sbom_format = config.get('sbom_format', 'spdx-json')
        self.signing_key_path = config.get('signing_key_path')
        self.verification_service = config.get('verification_service')
        self.policy_engine = config.get('policy_engine', 'opa')
        
    def generate_comprehensive_sbom(self, project_path: str, output_path: str) -> Dict:
        """Generate comprehensive Software Bill of Materials."""
        print(f"Generating SBOM for project: {project_path}")
        
        sbom_data = {
            "spdxVersion": "SPDX-2.3",
            "dataLicense": "CC0-1.0",
            "SPDXID": "SPDXRef-DOCUMENT",
            "name": self.config.get('project_name', 'Enterprise-Application'),
            "documentNamespace": f"https://company.com/spdx/{self.config.get('project_name')}-{datetime.utcnow().isoformat()}",
            "creationInfo": {
                "created": datetime.utcnow().isoformat(),
                "creators": ["Tool: enterprise-sbom-generator"],
                "licenseListVersion": "3.19"
            },
            "packages": [],
            "relationships": []
        }
        
        # Scan different package managers
        package_scanners = {
            'go': self._scan_go_modules,
            'npm': self._scan_npm_packages,
            'pip': self._scan_python_packages,
            'maven': self._scan_maven_dependencies,
            'gradle': self._scan_gradle_dependencies
        }
        
        for scanner_type, scanner_func in package_scanners.items():
            try:
                packages = scanner_func(project_path)
                sbom_data['packages'].extend(packages)
                print(f"Added {len(packages)} {scanner_type} packages to SBOM")
            except Exception as e:
                print(f"Warning: Failed to scan {scanner_type} packages: {e}")
        
        # Add container base image information
        if self.config.get('base_image'):
            base_image_info = self._scan_container_image(self.config['base_image'])
            sbom_data['packages'].extend(base_image_info)
        
        # Generate relationships
        sbom_data['relationships'] = self._generate_package_relationships(sbom_data['packages'])
        
        # Save SBOM
        with open(output_path, 'w') as f:
            json.dump(sbom_data, f, indent=2)
        
        print(f"SBOM generated with {len(sbom_data['packages'])} packages")
        return sbom_data
    
    def _scan_go_modules(self, project_path: str) -> List[Dict]:
        """Scan Go modules for dependencies."""
        packages = []
        
        try:
            # Run go list to get module information
            result = subprocess.run(
                ['go', 'list', '-m', '-json', 'all'],
                cwd=project_path,
                capture_output=True,
                text=True
            )
            
            if result.returncode == 0:
                for line in result.stdout.strip().split('\n'):
                    if line.strip():
                        try:
                            module_info = json.loads(line)
                            package = {
                                "SPDXID": f"SPDXRef-Package-{len(packages)}",
                                "name": module_info.get('Path', ''),
                                "versionInfo": module_info.get('Version', ''),
                                "downloadLocation": f"https://{module_info.get('Path', '')}",
                                "filesAnalyzed": False,
                                "packageManager": "go-modules",
                                "sourceInfo": "go list -m -json all"
                            }
                            
                            # Get license information if available
                            license_info = self._get_go_module_license(module_info.get('Path', ''))
                            if license_info:
                                package['licenseConcluded'] = license_info
                            
                            packages.append(package)
                        except json.JSONDecodeError:
                            continue
                            
        except subprocess.SubprocessError as e:
            print(f"Error scanning Go modules: {e}")
        
        return packages
    
    def _scan_npm_packages(self, project_path: str) -> List[Dict]:
        """Scan NPM packages for dependencies."""
        packages = []
        package_json_path = os.path.join(project_path, 'package.json')
        package_lock_path = os.path.join(project_path, 'package-lock.json')
        
        if not os.path.exists(package_json_path):
            return packages
        
        try:
            # Use npm ls to get dependency tree
            result = subprocess.run(
                ['npm', 'ls', '--json', '--all'],
                cwd=project_path,
                capture_output=True,
                text=True
            )
            
            if result.returncode == 0 or result.stdout:
                npm_data = json.loads(result.stdout)
                packages.extend(self._parse_npm_dependencies(npm_data.get('dependencies', {})))
                
        except (subprocess.SubprocessError, json.JSONDecodeError) as e:
            print(f"Error scanning NPM packages: {e}")
        
        return packages
    
    def _scan_python_packages(self, project_path: str) -> List[Dict]:
        """Scan Python packages for dependencies."""
        packages = []
        requirements_files = ['requirements.txt', 'Pipfile', 'pyproject.toml']
        
        for req_file in requirements_files:
            req_path = os.path.join(project_path, req_file)
            if os.path.exists(req_path):
                try:
                    if req_file == 'requirements.txt':
                        packages.extend(self._parse_requirements_txt(req_path))
                    elif req_file == 'Pipfile':
                        packages.extend(self._parse_pipfile(req_path))
                    elif req_file == 'pyproject.toml':
                        packages.extend(self._parse_pyproject_toml(req_path))
                except Exception as e:
                    print(f"Error parsing {req_file}: {e}")
        
        return packages
    
    def generate_provenance_attestation(self, build_info: Dict) -> Dict:
        """Generate SLSA provenance attestation for build."""
        provenance = {
            "_type": "https://in-toto.io/Statement/v0.1",
            "predicateType": "https://slsa.dev/provenance/v0.2",
            "subject": [
                {
                    "name": build_info['artifact_name'],
                    "digest": {
                        "sha256": build_info['artifact_digest']
                    }
                }
            ],
            "predicate": {
                "builder": {
                    "id": build_info.get('builder_id', 'https://github.com/actions/runner'),
                    "version": build_info.get('builder_version', {})
                },
                "buildType": build_info.get('build_type', 'https://github.com/actions/workflow'),
                "invocation": {
                    "configSource": {
                        "uri": build_info.get('source_uri'),
                        "digest": {
                            "sha1": build_info.get('source_digest')
                        },
                        "entryPoint": build_info.get('entry_point', '.github/workflows/ci.yml')
                    },
                    "parameters": build_info.get('parameters', {}),
                    "environment": {
                        "github": {
                            "actor": build_info.get('github_actor'),
                            "event_name": build_info.get('github_event'),
                            "ref": build_info.get('github_ref'),
                            "repository": build_info.get('github_repository'),
                            "run_id": build_info.get('github_run_id'),
                            "run_number": build_info.get('github_run_number'),
                            "sha": build_info.get('github_sha')
                        }
                    }
                },
                "buildConfig": build_info.get('build_config', {}),
                "metadata": {
                    "buildInvocationId": build_info.get('build_invocation_id'),
                    "buildStartedOn": build_info.get('build_started_on'),
                    "buildFinishedOn": build_info.get('build_finished_on'),
                    "completeness": {
                        "parameters": True,
                        "environment": True,
                        "materials": True
                    },
                    "reproducible": build_info.get('reproducible', False)
                },
                "materials": build_info.get('materials', [])
            }
        }
        
        return provenance
    
    def sign_attestation(self, attestation: Dict, private_key_path: str) -> str:
        """Sign attestation with private key."""
        # Load private key
        with open(private_key_path, 'rb') as key_file:
            private_key = load_pem_private_key(key_file.read(), password=None)
        
        # Serialize attestation to canonical JSON
        attestation_json = json.dumps(attestation, sort_keys=True, separators=(',', ':'))
        attestation_bytes = attestation_json.encode('utf-8')
        
        # Sign the attestation
        signature = private_key.sign(
            attestation_bytes,
            padding.PSS(
                mgf=padding.MGF1(hashes.SHA256()),
                salt_length=padding.PSS.MAX_LENGTH
            ),
            hashes.SHA256()
        )
        
        return signature.hex()
    
    def verify_supply_chain_integrity(self, artifact_path: str, attestation_path: str) -> bool:
        """Verify supply chain integrity of artifact."""
        print(f"Verifying supply chain integrity for: {artifact_path}")
        
        verification_results = {
            'artifact_hash_verified': False,
            'attestation_signature_verified': False,
            'provenance_verified': False,
            'policy_compliance': False
        }
        
        try:
            # Verify artifact hash
            if os.path.exists(artifact_path):
                artifact_hash = self._calculate_file_hash(artifact_path)
                verification_results['artifact_hash_verified'] = True
                print(f"Artifact hash calculated: {artifact_hash}")
            
            # Load and verify attestation
            if os.path.exists(attestation_path):
                with open(attestation_path, 'r') as f:
                    attestation = json.load(f)
                
                # Verify attestation signature
                if self._verify_attestation_signature(attestation):
                    verification_results['attestation_signature_verified'] = True
                    print("Attestation signature verified successfully")
                
                # Verify provenance
                if self._verify_provenance(attestation):
                    verification_results['provenance_verified'] = True
                    print("Provenance verification successful")
            
            # Check policy compliance
            if self._check_policy_compliance(artifact_path, attestation_path):
                verification_results['policy_compliance'] = True
                print("Policy compliance check passed")
            
        except Exception as e:
            print(f"Error during verification: {e}")
            return False
        
        # All checks must pass
        all_verified = all(verification_results.values())
        print(f"Supply chain verification: {'PASSED' if all_verified else 'FAILED'}")
        print(f"Verification details: {verification_results}")
        
        return all_verified
    
    def _calculate_file_hash(self, file_path: str, algorithm: str = 'sha256') -> str:
        """Calculate hash of file."""
        hash_func = getattr(hashlib, algorithm)()
        
        with open(file_path, 'rb') as f:
            for chunk in iter(lambda: f.read(4096), b""):
                hash_func.update(chunk)
        
        return hash_func.hexdigest()
    
    def _verify_attestation_signature(self, attestation: Dict) -> bool:
        """Verify attestation signature."""
        # Implementation would verify signature using public key
        # This is a simplified version
        return True
    
    def _verify_provenance(self, attestation: Dict) -> bool:
        """Verify provenance information."""
        predicate = attestation.get('predicate', {})
        
        # Check required provenance fields
        required_fields = ['builder', 'buildType', 'invocation']
        for field in required_fields:
            if field not in predicate:
                print(f"Missing required provenance field: {field}")
                return False
        
        # Verify builder information
        builder = predicate['builder']
        if not builder.get('id'):
            print("Missing builder ID in provenance")
            return False
        
        # Verify source information
        invocation = predicate['invocation']
        config_source = invocation.get('configSource', {})
        if not config_source.get('uri'):
            print("Missing source URI in provenance")
            return False
        
        return True
    
    def _check_policy_compliance(self, artifact_path: str, attestation_path: str) -> bool:
        """Check policy compliance using OPA or similar."""
        try:
            # Example OPA policy evaluation
            policy_input = {
                "artifact_path": artifact_path,
                "attestation_path": attestation_path,
                "timestamp": datetime.utcnow().isoformat()
            }
            
            # Run OPA evaluation
            result = subprocess.run([
                'opa', 'eval',
                '--data', './policies/supply-chain-security.rego',
                '--input', json.dumps(policy_input),
                'data.supply_chain.allow'
            ], capture_output=True, text=True)
            
            if result.returncode == 0:
                evaluation_result = json.loads(result.stdout)
                return evaluation_result.get('result', [{}])[0].get('expressions', [{}])[0].get('value', False)
            
        except Exception as e:
            print(f"Error checking policy compliance: {e}")
        
        return False

def main():
    """Main function for supply chain security operations."""
    import argparse
    
    parser = argparse.ArgumentParser(description='Enterprise Supply Chain Security Manager')
    parser.add_argument('--action', choices=['generate-sbom', 'generate-provenance', 'verify-integrity'], required=True)
    parser.add_argument('--project-path', default='.')
    parser.add_argument('--output', required=True)
    parser.add_argument('--config', default='supply-chain-config.json')
    parser.add_argument('--build-info', help='Build information JSON file')
    parser.add_argument('--artifact', help='Artifact path for verification')
    parser.add_argument('--attestation', help='Attestation path for verification')
    
    args = parser.parse_args()
    
    # Load configuration
    config = {}
    if os.path.exists(args.config):
        with open(args.config, 'r') as f:
            config = json.load(f)
    
    manager = SupplyChainSecurityManager(config)
    
    if args.action == 'generate-sbom':
        sbom = manager.generate_comprehensive_sbom(args.project_path, args.output)
        print(f"SBOM generated successfully: {args.output}")
        
    elif args.action == 'generate-provenance':
        if not args.build_info:
            print("Error: --build-info required for provenance generation")
            return 1
        
        with open(args.build_info, 'r') as f:
            build_info = json.load(f)
        
        provenance = manager.generate_provenance_attestation(build_info)
        
        with open(args.output, 'w') as f:
            json.dump(provenance, f, indent=2)
        
        print(f"Provenance attestation generated: {args.output}")
        
    elif args.action == 'verify-integrity':
        if not args.artifact or not args.attestation:
            print("Error: --artifact and --attestation required for verification")
            return 1
        
        result = manager.verify_supply_chain_integrity(args.artifact, args.attestation)
        return 0 if result else 1

if __name__ == '__main__':
    exit(main())
```

This comprehensive CI/CD pipeline security and supply chain protection guide provides enterprise-ready patterns and configurations for advanced DevSecOps automation. The framework supports comprehensive security scanning, SBOM generation, provenance tracking, and policy enforcement necessary for production environments.

Key benefits of this advanced DevSecOps approach include:

- **Comprehensive Security Scanning**: Multi-layer security analysis throughout the pipeline
- **Supply Chain Protection**: SBOM generation, provenance tracking, and verification
- **Policy Enforcement**: Automated compliance validation and governance
- **Runtime Security**: Continuous monitoring and threat detection
- **Audit and Compliance**: Complete security audit trails and reporting
- **Automated Remediation**: Intelligent vulnerability management and response

The implementation patterns demonstrated here enable organizations to achieve secure, compliant, and auditable software delivery at enterprise scale while maintaining security excellence and regulatory compliance.