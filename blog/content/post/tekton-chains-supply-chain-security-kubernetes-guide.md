---
title: "Tekton Chains: Supply Chain Security for Kubernetes CI/CD"
date: 2027-01-13T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Tekton", "Supply Chain Security", "SLSA", "Sigstore"]
categories: ["Kubernetes", "Security", "CI/CD"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to implementing Tekton Chains for supply chain security in Kubernetes CI/CD pipelines, covering SLSA attestations, Cosign image signing, KMS key integration, Rekor transparency logging, and admission policy enforcement."
more_link: "yes"
url: "/tekton-chains-supply-chain-security-kubernetes-guide/"
---

Software supply chain attacks have become one of the most significant risks facing production infrastructure. **Tekton Chains** addresses this threat by automatically generating cryptographically signed provenance attestations for every `TaskRun` and `PipelineRun` that executes in a cluster. Combined with **Sigstore**, **Rekor**, and admission-time policy enforcement, Chains provides a complete audit trail from source code commit to running container—satisfying SLSA Level 2 and the groundwork for Level 3 with minimal pipeline changes.

<!--more-->

## Tekton Chains Architecture

Tekton Chains operates as a Kubernetes controller that watches `TaskRun` and `PipelineRun` objects. When a run completes, the Chains controller:

1. Extracts build inputs and outputs (image digests, git commits, parameters) from the run's status.
2. Formats the provenance data as an **in-toto attestation** in the configured format (`slsaprovenance`, `slsaprovenance02`, or `tektonv1`).
3. Signs the attestation using a configured signing key (KMS, Kubernetes secret, or Fulcio).
4. Stores the signed attestation alongside the artifact—either in the OCI registry as an attestation manifest or in a configurable storage backend.
5. Optionally uploads the signature and attestation to the **Rekor** transparency log for independent auditability.

```
                    ┌─────────────────────────────────────┐
                    │         Tekton Pipeline              │
                    │  Task → TaskRun (completed)          │
                    └────────────────┬────────────────────┘
                                     │ watch
                    ┌────────────────▼────────────────────┐
                    │         Chains Controller            │
                    │  1. Extract build metadata           │
                    │  2. Format in-toto attestation       │
                    │  3. Sign with KMS/Fulcio key         │
                    │  4. Store attestation in OCI/GCS     │
                    │  5. Upload to Rekor log              │
                    └─────────────────────────────────────┘
                           │                │
                    ┌──────▼──────┐  ┌──────▼──────┐
                    │ OCI Registry│  │ Rekor Log   │
                    │ (attestation│  │ (public     │
                    │  manifest)  │  │  ledger)    │
                    └─────────────┘  └─────────────┘
```

### SLSA Provenance Levels

**SLSA** (Supply-chain Levels for Software Artifacts) defines four levels of provenance guarantees:

| Level | Requirement |
|-------|-------------|
| SLSA 1 | Provenance exists (unsigned) |
| SLSA 2 | Provenance is signed by the build platform |
| SLSA 3 | Provenance is non-falsifiable; build runs in a hardened environment |
| SLSA 4 | Two-person review; hermetic, reproducible builds |

Tekton Chains with a KMS-backed signing key and Rekor upload satisfies **SLSA Level 2** out of the box. SLSA Level 3 additionally requires an isolated build environment (use Tekton with OPA Gatekeeper policies restricting TaskRun mutation) and a hosted build platform audit log.

## Installing Tekton Chains

### Prerequisites

Tekton Pipelines v0.44 or later must already be installed. Verify:

```bash
kubectl get deployment -n tekton-pipelines tekton-pipelines-controller \
  -o jsonpath='{.spec.template.spec.containers[0].image}'
```

### Installing Chains

```bash
#!/bin/bash
# Install Tekton Chains
set -euo pipefail

CHAINS_VERSION="0.21.0"

kubectl apply -f \
  "https://storage.googleapis.com/tekton-releases/chains/previous/v${CHAINS_VERSION}/release.yaml"

# Wait for Chains controller to be ready
kubectl -n tekton-chains wait deployment/tekton-chains-controller \
  --for=condition=Available \
  --timeout=120s

echo "Tekton Chains ${CHAINS_VERSION} installed."
kubectl -n tekton-chains get pods
```

## Signing Key Configuration

Chains supports three signing backends. KMS is recommended for production because the private key never leaves the HSM.

### AWS KMS Integration

```bash
#!/bin/bash
# Configure Tekton Chains with AWS KMS signing key
set -euo pipefail

AWS_REGION="us-east-1"
KEY_ALIAS="tekton-chains-signing-key"

# Create a KMS key for signing
KEY_ID=$(aws kms create-key \
  --description "Tekton Chains signing key" \
  --key-usage SIGN_VERIFY \
  --key-spec ECC_NIST_P256 \
  --region "${AWS_REGION}" \
  --query "KeyMetadata.KeyId" \
  --output text)

aws kms create-alias \
  --alias-name "alias/${KEY_ALIAS}" \
  --target-key-id "${KEY_ID}" \
  --region "${AWS_REGION}"

KMS_URI="awskms:///alias/${KEY_ALIAS}"
echo "KMS key ARN: ${KEY_ID}"
echo "Chains KMS URI: ${KMS_URI}"

# Create IRSA annotation for the Chains service account
# (assumes EKS with OIDC provider configured)
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
OIDC_PROVIDER=$(aws eks describe-cluster \
  --name "${EKS_CLUSTER_NAME}" \
  --query "cluster.identity.oidc.issuer" \
  --output text | sed 's|https://||')

cat > chains-trust-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::${ACCOUNT_ID}:oidc-provider/${OIDC_PROVIDER}"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "${OIDC_PROVIDER}:sub": "system:serviceaccount:tekton-chains:tekton-chains-controller",
          "${OIDC_PROVIDER}:aud": "sts.amazonaws.com"
        }
      }
    }
  ]
}
EOF

ROLE_ARN=$(aws iam create-role \
  --role-name TektonChainsSigningRole \
  --assume-role-policy-document file://chains-trust-policy.json \
  --query "Role.Arn" \
  --output text)

aws iam put-role-policy \
  --role-name TektonChainsSigningRole \
  --policy-name KMSSigningPolicy \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Effect\": \"Allow\",
      \"Action\": [\"kms:Sign\", \"kms:GetPublicKey\", \"kms:DescribeKey\"],
      \"Resource\": \"arn:aws:kms:${AWS_REGION}:${ACCOUNT_ID}:key/${KEY_ID}\"
    }]
  }"

# Annotate the Chains service account for IRSA
kubectl annotate serviceaccount \
  -n tekton-chains tekton-chains-controller \
  "eks.amazonaws.com/role-arn=${ROLE_ARN}"

echo "IRSA configured. Role ARN: ${ROLE_ARN}"
```

### GCP KMS Integration

```bash
#!/bin/bash
# Configure Tekton Chains with GCP KMS
set -euo pipefail

PROJECT_ID="my-project"
LOCATION="global"
KEYRING="tekton-chains"
KEY_NAME="signing-key"
KEY_VERSION="1"

# Create keyring and key
gcloud kms keyrings create "${KEYRING}" \
  --location="${LOCATION}" \
  --project="${PROJECT_ID}"

gcloud kms keys create "${KEY_NAME}" \
  --keyring="${KEYRING}" \
  --location="${LOCATION}" \
  --purpose=asymmetric-signing \
  --default-algorithm=ec-sign-p256-sha256 \
  --project="${PROJECT_ID}"

KMS_URI="gcpkms://projects/${PROJECT_ID}/locations/${LOCATION}/keyRings/${KEYRING}/cryptoKeys/${KEY_NAME}/cryptoKeyVersions/${KEY_VERSION}"

# Grant Workload Identity access
CHAINS_SA="tekton-chains-controller@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud iam service-accounts add-iam-policy-binding "${CHAINS_SA}" \
  --role="roles/iam.workloadIdentityUser" \
  --member="serviceAccount:${PROJECT_ID}.svc.id.goog[tekton-chains/tekton-chains-controller]" \
  --project="${PROJECT_ID}"

gcloud kms keys add-iam-policy-binding "${KEY_NAME}" \
  --keyring="${KEYRING}" \
  --location="${LOCATION}" \
  --member="serviceAccount:${CHAINS_SA}" \
  --role="roles/cloudkms.signerVerifier" \
  --project="${PROJECT_ID}"

echo "GCP KMS URI: ${KMS_URI}"
```

### Applying the Chains Configuration

```yaml
# Tekton Chains configuration ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: chains-config
  namespace: tekton-chains
data:
  # Artifacts to sign and their storage backends
  artifacts.oci.format: "simplesigning"
  artifacts.oci.storage: "oci,tekton"
  artifacts.oci.signer: "kms"

  artifacts.pipelinerun.format: "slsaprovenance02"
  artifacts.pipelinerun.storage: "oci,tekton"
  artifacts.pipelinerun.signer: "kms"

  artifacts.taskrun.format: "slsaprovenance02"
  artifacts.taskrun.storage: "oci,tekton"
  artifacts.taskrun.signer: "kms"

  # KMS signing key URI
  signers.kms.kmsref: "awskms:///alias/tekton-chains-signing-key"

  # Rekor transparency log
  transparency.enabled: "true"
  transparency.url: "https://rekor.sigstore.dev"

  # Builder identity
  builder.id: "https://tekton.production.example.com/pipelines"
```

## Complete SLSA Level 2 Pipeline Example

This example builds a container image, pushes it, and automatically generates a signed SLSA provenance attestation.

### Pipeline Definition

```yaml
# SLSA Level 2 build pipeline
apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: slsa-build-pipeline
  namespace: ci
  annotations:
    # Signal to Chains that this pipeline generates provenance
    chains.tekton.dev/signed: "true"
spec:
  params:
    - name: git-url
      type: string
    - name: git-revision
      type: string
    - name: image-name
      type: string
    - name: image-tag
      type: string

  workspaces:
    - name: source
    - name: docker-credentials

  results:
    # Results used by Chains to identify the built artifact
    - name: IMAGE_URL
      value: $(tasks.build-image.results.IMAGE_URL)
    - name: IMAGE_DIGEST
      value: $(tasks.build-image.results.IMAGE_DIGEST)
    - name: CHAINS-GIT_COMMIT
      value: $(tasks.clone-source.results.commit)
    - name: CHAINS-GIT_URL
      value: $(tasks.clone-source.results.url)

  tasks:
    - name: clone-source
      taskRef:
        resolver: hub
        params:
          - name: catalog
            value: tekton-catalog-tasks
          - name: type
            value: artifact
          - name: kind
            value: task
          - name: name
            value: git-clone
          - name: version
            value: "0.9"
      params:
        - name: url
          value: $(params.git-url)
        - name: revision
          value: $(params.git-revision)
      workspaces:
        - name: output
          workspace: source

    - name: run-tests
      runAfter: ["clone-source"]
      taskRef:
        name: run-unit-tests
      workspaces:
        - name: source
          workspace: source

    - name: build-image
      runAfter: ["run-tests"]
      taskRef:
        name: kaniko-build
      params:
        - name: IMAGE
          value: "$(params.image-name):$(params.image-tag)"
        - name: CONTEXT
          value: "."
        - name: DOCKERFILE
          value: "./Dockerfile"
      workspaces:
        - name: source
          workspace: source
        - name: dockerconfig
          workspace: docker-credentials
```

### Kaniko Build Task with Required Results

Chains identifies the built image using the `IMAGE_URL` and `IMAGE_DIGEST` task results. These must be emitted correctly:

```yaml
apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: kaniko-build
  namespace: ci
spec:
  params:
    - name: IMAGE
      type: string
    - name: CONTEXT
      default: "."
    - name: DOCKERFILE
      default: "./Dockerfile"

  workspaces:
    - name: source
    - name: dockerconfig

  results:
    - name: IMAGE_URL
      description: The URL of the built image
    - name: IMAGE_DIGEST
      description: The digest of the built image

  steps:
    - name: build-and-push
      image: gcr.io/kaniko-project/executor:v1.21.0-debug
      env:
        - name: DOCKER_CONFIG
          value: /kaniko/.docker
      command:
        - /kaniko/executor
      args:
        - --dockerfile=$(params.DOCKERFILE)
        - --context=/workspace/source/$(params.CONTEXT)
        - --destination=$(params.IMAGE)
        - --digest-file=/tekton/results/IMAGE_DIGEST
        - --cache=true
        - --cache-repo=$(params.IMAGE)-cache
        - --reproducible
      volumeMounts:
        - name: docker-creds
          mountPath: /kaniko/.docker

    - name: write-image-url
      image: busybox:1.36
      script: |
        #!/bin/sh
        echo -n "$(params.IMAGE)" > /tekton/results/IMAGE_URL

  volumes:
    - name: docker-creds
      projected:
        sources:
          - secret:
              name: registry-credentials
              items:
                - key: .dockerconfigjson
                  path: config.json
```

### Triggering the Pipeline

```yaml
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  name: app-build-20270113-001
  namespace: ci
  annotations:
    # Mark this run for Chains processing
    chains.tekton.dev/signed: "true"
spec:
  pipelineRef:
    name: slsa-build-pipeline
  params:
    - name: git-url
      value: "https://github.com/example-org/app-service.git"
    - name: git-revision
      value: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
    - name: image-name
      value: "registry.example.com/app-service"
    - name: image-tag
      value: "v1.4.2"
  workspaces:
    - name: source
      volumeClaimTemplate:
        spec:
          accessModes: [ReadWriteOnce]
          resources:
            requests:
              storage: 1Gi
    - name: docker-credentials
      secret:
        secretName: registry-credentials
```

## OCI Image Signing with Cosign

After the pipeline completes and Chains signs the provenance, verify the signature and attestation with `cosign`.

### Verifying the OCI Signature

```bash
#!/bin/bash
# Verify image signature and SLSA attestation
set -euo pipefail

IMAGE_REF="registry.example.com/app-service@sha256:abc123def456..."
KMS_KEY_URI="awskms:///alias/tekton-chains-signing-key"

# Extract the public key from KMS
cosign public-key --key "${KMS_KEY_URI}" > chains-public-key.pem

# Verify the image signature
cosign verify \
  --key chains-public-key.pem \
  "${IMAGE_REF}"

# Verify and decode the SLSA provenance attestation
cosign verify-attestation \
  --key chains-public-key.pem \
  --type slsaprovenance02 \
  "${IMAGE_REF}" | jq '.payload | @base64d | fromjson'
```

### Verifying Against Rekor

```bash
#!/bin/bash
# Verify signature existence in Rekor transparency log
set -euo pipefail

IMAGE_REF="registry.example.com/app-service@sha256:abc123def456..."

# Search Rekor for entries associated with this image
rekor-cli search --artifact "${IMAGE_REF}"

# Retrieve and verify a specific entry by UUID
ENTRY_UUID="<uuid-from-rekor-search>"
rekor-cli get --uuid "${ENTRY_UUID}" --format json | jq .
```

## Storing Attestations in OCI Registry

Chains stores attestations as OCI referrers attached to the image manifest. The storage format can be configured independently for different artifact types.

### OCI Storage Configuration

```yaml
# chains-config entries for OCI attestation storage
data:
  # Store TaskRun attestations in OCI registry
  artifacts.taskrun.storage: "oci"
  # Format: slsaprovenance02 generates SLSA v0.2 predicate
  artifacts.taskrun.format: "slsaprovenance02"

  # Store OCI image signatures and attestations
  artifacts.oci.storage: "oci"
  artifacts.oci.format: "simplesigning"
  artifacts.oci.signer: "kms"
```

Attestations are stored with the media type `application/vnd.dev.cosign.artifact.attestation.v1+json` and are discoverable via the OCI referrers API.

### Listing Attestations for an Image

```bash
# List all attestations attached to an image
cosign tree registry.example.com/app-service:v1.4.2

# Download and inspect the attestation payload
cosign download attestation \
  --predicate-type https://slsa.dev/provenance/v0.2 \
  registry.example.com/app-service:v1.4.2 \
  | jq '.payload | @base64d | fromjson'
```

## SPIFFE/SPIRE Integration

For keyless signing, Chains can use Fulcio with SPIFFE/SPIRE to issue short-lived signing certificates, eliminating the need to manage long-lived KMS keys.

### Configuring Keyless Signing

```yaml
# chains-config for keyless signing with Fulcio
data:
  signers.x509.fulcio.enabled: "true"
  signers.x509.fulcio.address: "https://fulcio.sigstore.dev"
  signers.x509.tuf.mirror.url: "https://tuf.sigstore.dev"

  # SPIRE integration
  signers.x509.spiffe.enabled: "true"
  signers.x509.spiffe.socketPath: "unix:///run/spiffe/workload-api/agent.sock"
```

With keyless signing, the certificate embeds the Chains controller's SPIFFE identity (e.g., `spiffe://production.example.com/ns/tekton-chains/sa/tekton-chains-controller`), providing an auditable identity without managing signing keys.

## Policy Enforcement at Admission

Signed attestations have limited value unless admission controllers verify them before deploying images. Use **Kyverno** or **Cosign Policy Controller** to enforce attestation verification at admission time.

### Kyverno Policy for Attestation Verification

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-slsa-provenance
  annotations:
    policies.kyverno.io/description: >
      Require all images in production namespace to have a valid
      SLSA provenance attestation signed by Tekton Chains.
spec:
  validationFailureAction: Enforce
  background: false
  rules:
    - name: check-slsa-attestation
      match:
        any:
          - resources:
              kinds: [Pod]
              namespaces: [production]
      verifyImages:
        - imageReferences:
            - "registry.example.com/*"
          attestors:
            - count: 1
              entries:
                - keys:
                    publicKeys: |-
                      -----BEGIN PUBLIC KEY-----
                      MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEXXXXXXXXXXXXXXXXXXXXXXXXXX
                      XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
                      -----END PUBLIC KEY-----
                    rekor:
                      url: https://rekor.sigstore.dev
          attestations:
            - predicateType: "https://slsa.dev/provenance/v0.2"
              conditions:
                - all:
                    - key: "{{ builder.id }}"
                      operator: Equals
                      value: "https://tekton.production.example.com/pipelines"
                    - key: "{{ invocation.parameters.git-url }}"
                      operator: Equals
                      value: "https://github.com/example-org/app-service.git"
```

### Cosign Policy Controller

The **Cosign Policy Controller** (part of Sigstore) provides a purpose-built Kubernetes admission webhook for image verification.

```yaml
# ClusterImagePolicy for the Cosign Policy Controller
apiVersion: policy.sigstore.dev/v1beta1
kind: ClusterImagePolicy
metadata:
  name: production-slsa-policy
spec:
  images:
    - glob: "registry.example.com/**"
  authorities:
    - name: tekton-chains-kms
      key:
        kms: "awskms:///alias/tekton-chains-signing-key"
      ctlog:
        url: https://rekor.sigstore.dev
  policy:
    type: cue
    data: |
      import "strings"

      predicateType: "https://slsa.dev/provenance/v0.2"

      predicate: {
        builder: id: strings.HasPrefix("https://tekton.production.example.com")
        invocation: parameters: "git-url": strings.HasPrefix("https://github.com/example-org/")
        buildType: "https://tekton.dev/attestations/chains/pipelinerun@v2"
      }
```

## Monitoring Chains Operations

### Chains Controller Metrics

Tekton Chains exposes Prometheus metrics from its controller pod.

```yaml
# ServiceMonitor for Tekton Chains
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: tekton-chains
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
spec:
  namespaceSelector:
    matchNames:
      - tekton-chains
  selector:
    matchLabels:
      app: tekton-chains-controller
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics
```

### Key Operational Alerts

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: tekton-chains-alerts
  namespace: monitoring
spec:
  groups:
    - name: tekton.chains
      rules:
        - alert: TektonChainsSigningFailure
          expr: rate(tekton_chains_signing_failure_count_total[5m]) > 0
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "Tekton Chains signing failures detected"
            description: "{{ $value }} signing failures per second on {{ $labels.signer }}."

        - alert: TektonChainsStorageFailure
          expr: rate(tekton_chains_storage_failure_count_total[5m]) > 0
          for: 2m
          labels:
            severity: warning
          annotations:
            summary: "Tekton Chains attestation storage failures"
            description: "Attestations are failing to be stored in {{ $labels.storage_backend }}."

        - alert: TektonChainsControllerNotReady
          expr: kube_deployment_status_replicas_available{namespace="tekton-chains", deployment="tekton-chains-controller"} == 0
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "Tekton Chains controller has no available replicas"
            description: "No attestations will be generated until the controller recovers."
```

## Operational Runbook

### Verifying a PipelineRun Was Signed

```bash
#!/bin/bash
# Verify that a specific PipelineRun has been processed by Chains
set -euo pipefail

NAMESPACE="ci"
PIPELINERUN_NAME="app-build-20270113-001"

echo "=== Checking Chains annotations ==="
kubectl -n "${NAMESPACE}" get pipelinerun "${PIPELINERUN_NAME}" \
  -o jsonpath='{.metadata.annotations}' | jq 'to_entries | map(select(.key | startswith("chains")))'

echo ""
echo "=== Checking signing status ==="
kubectl -n "${NAMESPACE}" get pipelinerun "${PIPELINERUN_NAME}" \
  -o jsonpath='{.metadata.annotations.chains\.tekton\.dev/signed}'

echo ""
echo "=== Checking transparency log upload ==="
kubectl -n "${NAMESPACE}" get pipelinerun "${PIPELINERUN_NAME}" \
  -o jsonpath='{.metadata.annotations.chains\.tekton\.dev/transparency}'
```

### Re-triggering Signing for a Failed Run

If a run completed but Chains failed to sign (e.g., KMS was temporarily unavailable):

```bash
#!/bin/bash
# Remove the 'failed' annotation to trigger Chains to retry signing
set -euo pipefail

NAMESPACE="ci"
PIPELINERUN_NAME="app-build-20270113-001"

kubectl -n "${NAMESPACE}" annotate pipelinerun "${PIPELINERUN_NAME}" \
  chains.tekton.dev/signed- \
  --overwrite

echo "Annotation removed. Chains will retry signing within 30 seconds."
```

### Rotating the Signing Key

```bash
#!/bin/bash
# Rotate the KMS signing key (AWS)
set -euo pipefail

OLD_KEY_ALIAS="tekton-chains-signing-key"
NEW_KEY_ALIAS="tekton-chains-signing-key-v2"
AWS_REGION="us-east-1"

# Create new key
NEW_KEY_ID=$(aws kms create-key \
  --description "Tekton Chains signing key v2" \
  --key-usage SIGN_VERIFY \
  --key-spec ECC_NIST_P256 \
  --region "${AWS_REGION}" \
  --query "KeyMetadata.KeyId" \
  --output text)

aws kms create-alias \
  --alias-name "alias/${NEW_KEY_ALIAS}" \
  --target-key-id "${NEW_KEY_ID}" \
  --region "${AWS_REGION}"

# Update chains-config to reference new key
kubectl -n tekton-chains patch configmap chains-config \
  --type merge \
  -p "{\"data\":{\"signers.kms.kmsref\":\"awskms:///alias/${NEW_KEY_ALIAS}\"}}"

# Restart the Chains controller to pick up the new key
kubectl -n tekton-chains rollout restart deployment/tekton-chains-controller

# Publish the new public key for verifiers
aws kms get-public-key \
  --key-id "${NEW_KEY_ID}" \
  --region "${AWS_REGION}" \
  --query "PublicKey" \
  --output text | base64 --decode > chains-public-key-v2.der

openssl ec -inform DER -in chains-public-key-v2.der -pubin -pubout \
  -out chains-public-key-v2.pem

echo "New public key written to chains-public-key-v2.pem"
echo "Update admission policies with the new public key."
```

## Summary

Tekton Chains brings automated, tamper-evident supply chain security to Kubernetes CI/CD with minimal pipeline changes. By attaching signed SLSA provenance attestations to every build artifact—backed by KMS for key management and Rekor for public transparency—teams achieve SLSA Level 2 compliance as a byproduct of their normal pipeline execution. The integration with Kyverno or Cosign Policy Controller closes the loop at admission time, ensuring that only images with valid provenance can reach production workloads. Combined with SPIFFE/SPIRE for keyless signing, Tekton Chains provides a complete, auditable chain of custody from git commit to running pod.
