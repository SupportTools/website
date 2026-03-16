---
title: "Helm Plugin Development: Building Custom Commands for Enterprise Workflows"
date: 2027-01-14T00:00:00-05:00
draft: false
tags: ["Helm", "Kubernetes", "DevOps", "Plugin Development"]
categories: ["Kubernetes", "DevOps", "Tools"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to developing Helm plugins in Bash and Go, covering plugin structure, Helm environment variables, hook integration, building a helm-audit plugin for deprecated APIs, packaging, distribution, and CI integration."
more_link: "yes"
url: "/helm-plugin-development-custom-commands-enterprise-guide/"
---

Helm's plugin system transforms the CLI from a static package manager into an extensible platform for enterprise workflows. Any executable—a shell script, a compiled Go binary, or a Python script—can become a first-class `helm` subcommand through a simple `plugin.yaml` descriptor. This guide covers the plugin contract in depth, builds two production-quality plugins (`helm-audit` for deprecated API detection and `helm-diff-summary` for human-readable upgrade previews), and establishes patterns for packaging, distribution, and CI integration.

<!--more-->

## Plugin Architecture and Contract

### Directory Structure

A Helm plugin is a directory containing at minimum a `plugin.yaml` file and one executable. Helm discovers plugins by scanning `$(helm env HELM_PLUGINS)`, which defaults to `~/.local/share/helm/plugins` on Linux.

```
~/.local/share/helm/plugins/
└── helm-audit/
    ├── plugin.yaml          # Required: metadata and entrypoint
    ├── install-binary.sh    # Optional: download binary on install
    ├── scripts/
    │   └── audit.sh
    ├── bin/
    │   └── helm-audit       # Compiled Go binary (platform-specific)
    └── README.md
```

### plugin.yaml Reference

```yaml
# plugin.yaml — complete reference
name: "audit"
version: "1.3.0"
usage: "Audit Helm releases for deprecated Kubernetes APIs"
description: |-
  Scans all deployed Helm releases in the current context and flags
  manifests that use Kubernetes API versions scheduled for removal.
  Outputs a structured report in text or JSON format.

# Entry point: path relative to the plugin directory
command: "$HELM_PLUGIN_DIR/bin/helm-audit"

# Minimum Helm version required
minHelm: "3.12.0"

# Hooks executed during plugin lifecycle events
hooks:
  install: "$HELM_PLUGIN_DIR/scripts/install-binary.sh"
  update: "$HELM_PLUGIN_DIR/scripts/install-binary.sh"
  delete: ""

# Inject Helm env vars into the plugin process
useTunnel: false

# Ignore flags: if true, pass all flags directly to the command
# without Helm pre-processing them
ignoreFlags: false

# Platform-specific overrides
platformCommand:
  - os: windows
    arch: amd64
    command: "$HELM_PLUGIN_DIR/bin/helm-audit.exe"
  - os: linux
    arch: arm64
    command: "$HELM_PLUGIN_DIR/bin/helm-audit-arm64"
```

### Environment Variables Available to Plugins

Helm injects a set of environment variables that plugins use to integrate with the active Helm context:

| Variable | Description |
|---|---|
| `HELM_PLUGINS` | Plugin installation directory |
| `HELM_PLUGIN_DIR` | This plugin's directory |
| `HELM_PLUGIN_NAME` | The plugin's `name` field |
| `HELM_BIN` | Path to the helm binary |
| `HELM_DEBUG` | `1` when `--debug` is passed |
| `HELM_NAMESPACE` | Active namespace (`-n` flag) |
| `HELM_KUBECONTEXT` | Active kubeconfig context (`--kube-context`) |
| `HELM_KUBECONFIG` | Path to the active kubeconfig |
| `HELM_DATA_HOME` | Helm data directory |
| `HELM_CONFIG_HOME` | Helm config directory |
| `HELM_CACHE_HOME` | Helm cache directory |
| `HELM_REGISTRY_CONFIG` | OCI registry config path |
| `HELM_REPOSITORY_CACHE` | Repository cache path |
| `HELM_REPOSITORY_CONFIG` | Repository config path |

## Building helm-diff-summary (Bash Plugin)

`helm-diff-summary` wraps the `helm diff` plugin and formats its output as a human-readable summary suitable for PR comments or Slack notifications.

### install-binary.sh

The install hook runs after `helm plugin install`. For a bash plugin, it installs any binary dependencies (here, `helm-diff`):

```bash
#!/usr/bin/env bash
# scripts/install-binary.sh — install plugin dependencies
set -euo pipefail

# Ensure helm-diff is installed (dependency)
if ! helm diff version &>/dev/null 2>&1; then
  echo "Installing helm-diff dependency..."
  helm plugin install https://github.com/databus23/helm-diff --version 3.9.4
fi

echo "helm-diff-summary dependencies installed."
```

### The Plugin Script

```bash
#!/usr/bin/env bash
# scripts/diff-summary.sh — helm diff-summary main script
set -euo pipefail

PLUGIN_VERSION="1.0.0"

usage() {
  cat <<EOF
helm diff-summary — summarise pending Helm release changes

Usage:
  helm diff-summary [OPTIONS] RELEASE CHART [CHART_FLAGS...]

Options:
  -n, --namespace NAMESPACE  Target namespace (default: \$HELM_NAMESPACE or 'default')
  -o, --output FORMAT        Output format: text|json|markdown (default: text)
  --values FILE              Values file to pass through to helm diff
  --set KEY=VALUE            Set value to pass through to helm diff
  -h, --help                 Show this help

Environment:
  HELM_NAMESPACE             Set by Helm when -n is passed
  HELM_KUBECONTEXT           Set by Helm when --kube-context is passed

Examples:
  helm diff-summary my-app ./charts/my-app
  helm diff-summary -n production -o markdown my-app oci://registry.example.com/charts/my-app:2.1.0
EOF
  exit 0
}

# Parse arguments
NAMESPACE="${HELM_NAMESPACE:-default}"
OUTPUT_FORMAT="text"
RELEASE=""
CHART=""
EXTRA_ARGS=()
VALUES_FILES=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage ;;
    -n|--namespace) NAMESPACE="$2"; shift 2 ;;
    -o|--output) OUTPUT_FORMAT="$2"; shift 2 ;;
    --values) VALUES_FILES+=("--values" "$2"); shift 2 ;;
    --set) EXTRA_ARGS+=("--set" "$2"); shift 2 ;;
    -*) EXTRA_ARGS+=("$1"); shift ;;
    *)
      if [[ -z "${RELEASE}" ]]; then
        RELEASE="$1"
      elif [[ -z "${CHART}" ]]; then
        CHART="$1"
      else
        EXTRA_ARGS+=("$1")
      fi
      shift
      ;;
  esac
done

[[ -z "${RELEASE}" || -z "${CHART}" ]] && { echo "Error: RELEASE and CHART are required." >&2; usage; }

HELM_CONTEXT_ARGS=()
[[ -n "${HELM_KUBECONTEXT:-}" ]] && HELM_CONTEXT_ARGS+=("--kube-context" "${HELM_KUBECONTEXT}")

# Run helm diff and capture output
DIFF_OUTPUT=$(helm diff upgrade \
  --namespace "${NAMESPACE}" \
  "${HELM_CONTEXT_ARGS[@]}" \
  "${VALUES_FILES[@]}" \
  "${EXTRA_ARGS[@]}" \
  "${RELEASE}" "${CHART}" 2>&1) || true

if [[ -z "${DIFF_OUTPUT}" ]]; then
  echo "No changes detected for release '${RELEASE}'."
  exit 0
fi

# Parse the diff output to count changes
ADDED=$(echo "${DIFF_OUTPUT}" | grep -c '^+[^+]' || true)
REMOVED=$(echo "${DIFF_OUTPUT}" | grep -c '^-[^-]' || true)
CHANGED_RESOURCES=$(echo "${DIFF_OUTPUT}" | grep -E '^(---|\+\+\+)' | \
  grep -oP '(?<=\s)\S+/\S+' | sort -u | wc -l)

format_text() {
  echo "=========================================="
  echo "  Helm Diff Summary: ${RELEASE}"
  echo "  Namespace: ${NAMESPACE}"
  echo "  Chart: ${CHART}"
  echo "=========================================="
  echo "  Resources changed : ${CHANGED_RESOURCES}"
  echo "  Lines added       : ${ADDED}"
  echo "  Lines removed     : ${REMOVED}"
  echo "------------------------------------------"
  echo "Changed resources:"
  echo "${DIFF_OUTPUT}" | grep -E '^(---|\+\+\+)' | \
    grep -oP '(?<=\s)\S+/\S+' | sort -u | \
    sed 's/^/  - /'
  echo "=========================================="
}

format_json() {
  CHANGED_LIST=$(echo "${DIFF_OUTPUT}" | grep -E '^(---|\+\+\+)' | \
    grep -oP '(?<=\s)\S+/\S+' | sort -u | \
    jq -R . | jq -s .)
  jq -n \
    --arg release "${RELEASE}" \
    --arg ns "${NAMESPACE}" \
    --arg chart "${CHART}" \
    --argjson added "${ADDED}" \
    --argjson removed "${REMOVED}" \
    --argjson changed "${CHANGED_RESOURCES}" \
    --argjson resources "${CHANGED_LIST}" \
    '{release: $release, namespace: $ns, chart: $chart,
      lines_added: $added, lines_removed: $removed,
      resources_changed: $changed, changed_resources: $resources}'
}

format_markdown() {
  echo "## Helm Diff Summary: \`${RELEASE}\`"
  echo ""
  echo "| Field | Value |"
  echo "|-------|-------|"
  echo "| Release | \`${RELEASE}\` |"
  echo "| Namespace | \`${NAMESPACE}\` |"
  echo "| Chart | \`${CHART}\` |"
  echo "| Resources changed | ${CHANGED_RESOURCES} |"
  echo "| Lines added | +${ADDED} |"
  echo "| Lines removed | -${REMOVED} |"
  echo ""
  echo "### Changed Resources"
  echo ""
  echo "${DIFF_OUTPUT}" | grep -E '^(---|\+\+\+)' | \
    grep -oP '(?<=\s)\S+/\S+' | sort -u | \
    sed 's/^/- `/' | sed 's/$/`/'
}

case "${OUTPUT_FORMAT}" in
  text)     format_text ;;
  json)     format_json ;;
  markdown) format_markdown ;;
  *)
    echo "Error: unknown output format '${OUTPUT_FORMAT}'" >&2
    exit 1
    ;;
esac
```

### plugin.yaml for helm-diff-summary

```yaml
name: "diff-summary"
version: "1.0.0"
usage: "Summarise pending Helm release changes in text, JSON, or Markdown"
description: |-
  Wraps helm-diff to produce a concise change summary suitable for
  PR automation, Slack notifications, and change management records.
command: "$HELM_PLUGIN_DIR/scripts/diff-summary.sh"
minHelm: "3.12.0"
hooks:
  install: "$HELM_PLUGIN_DIR/scripts/install-binary.sh"
  update: "$HELM_PLUGIN_DIR/scripts/install-binary.sh"
```

## Building helm-audit (Go Plugin)

`helm-audit` scans deployed releases and flags manifests that use deprecated or removed Kubernetes API versions. It uses the Helm SDK and `kubectl.kubernetes.io/last-applied-configuration` annotations for accurate detection.

### Go Module Setup

```bash
mkdir helm-audit && cd helm-audit
go mod init github.com/example-org/helm-audit
go get helm.sh/helm/v3@v3.14.0
go get k8s.io/apimachinery@v0.29.0
go get sigs.k8s.io/yaml@v1.4.0
```

### main.go

```go
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"text/tabwriter"

	"helm.sh/helm/v3/pkg/action"
	"helm.sh/helm/v3/pkg/cli"
	"sigs.k8s.io/yaml"
)

// APIDeprecation describes a deprecated or removed Kubernetes API version
type APIDeprecation struct {
	OldAPI     string
	NewAPI     string
	RemovedIn  string
	Deprecated bool
	Removed    bool
}

// AuditFinding records a single deprecated API found in a release
type AuditFinding struct {
	Release   string `json:"release"`
	Namespace string `json:"namespace"`
	Resource  string `json:"resource"`
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	OldAPI    string `json:"deprecated_api"`
	NewAPI    string `json:"replacement_api"`
	RemovedIn string `json:"removed_in_version"`
	Removed   bool   `json:"already_removed"`
}

// deprecatedAPIs is a curated map of deprecated/removed API versions
// Format: "group/version/Kind" -> APIDeprecation
var deprecatedAPIs = map[string]APIDeprecation{
	"extensions/v1beta1/Ingress": {
		OldAPI:    "extensions/v1beta1",
		NewAPI:    "networking.k8s.io/v1",
		RemovedIn: "1.22",
		Removed:   true,
	},
	"networking.k8s.io/v1beta1/Ingress": {
		OldAPI:    "networking.k8s.io/v1beta1",
		NewAPI:    "networking.k8s.io/v1",
		RemovedIn: "1.22",
		Removed:   true,
	},
	"policy/v1beta1/PodSecurityPolicy": {
		OldAPI:    "policy/v1beta1",
		NewAPI:    "N/A (PSP removed)",
		RemovedIn: "1.25",
		Removed:   true,
	},
	"policy/v1beta1/PodDisruptionBudget": {
		OldAPI:    "policy/v1beta1",
		NewAPI:    "policy/v1",
		RemovedIn: "1.25",
		Removed:   true,
	},
	"apps/v1beta1/Deployment": {
		OldAPI:    "apps/v1beta1",
		NewAPI:    "apps/v1",
		RemovedIn: "1.16",
		Removed:   true,
	},
	"apps/v1beta2/Deployment": {
		OldAPI:    "apps/v1beta2",
		NewAPI:    "apps/v1",
		RemovedIn: "1.16",
		Removed:   true,
	},
	"autoscaling/v2beta1/HorizontalPodAutoscaler": {
		OldAPI:    "autoscaling/v2beta1",
		NewAPI:    "autoscaling/v2",
		RemovedIn: "1.26",
		Removed:   true,
	},
	"autoscaling/v2beta2/HorizontalPodAutoscaler": {
		OldAPI:    "autoscaling/v2beta2",
		NewAPI:    "autoscaling/v2",
		RemovedIn: "1.26",
		Removed:   true,
	},
	"batch/v1beta1/CronJob": {
		OldAPI:    "batch/v1beta1",
		NewAPI:    "batch/v1",
		RemovedIn: "1.25",
		Removed:   true,
	},
	"storage.k8s.io/v1beta1/StorageClass": {
		OldAPI:     "storage.k8s.io/v1beta1",
		NewAPI:     "storage.k8s.io/v1",
		RemovedIn:  "1.27",
		Deprecated: true,
		Removed:    false,
	},
	"rbac.authorization.k8s.io/v1alpha1/ClusterRole": {
		OldAPI:    "rbac.authorization.k8s.io/v1alpha1",
		NewAPI:    "rbac.authorization.k8s.io/v1",
		RemovedIn: "1.20",
		Removed:   true,
	},
}

type manifest struct {
	APIVersion string `yaml:"apiVersion"`
	Kind       string `yaml:"kind"`
	Metadata   struct {
		Name      string `yaml:"name"`
		Namespace string `yaml:"namespace"`
	} `yaml:"metadata"`
}

func main() {
	settings := cli.New()

	// Parse flags
	outputFormat := "text"
	showAll := false
	namespaceFilter := ""

	args := os.Args[1:]
	filteredArgs := []string{}
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--output", "-o":
			if i+1 < len(args) {
				outputFormat = args[i+1]
				i++
			}
		case "--all-namespaces", "-A":
			namespaceFilter = ""
			showAll = true
		case "--namespace", "-n":
			if i+1 < len(args) {
				namespaceFilter = args[i+1]
				i++
			}
		case "--help", "-h":
			printUsage()
			os.Exit(0)
		default:
			filteredArgs = append(filteredArgs, args[i])
		}
	}
	_ = filteredArgs

	// Respect HELM_NAMESPACE from environment (set by helm -n flag)
	if helmNS := os.Getenv("HELM_NAMESPACE"); helmNS != "" && namespaceFilter == "" && !showAll {
		namespaceFilter = helmNS
	}

	// Configure action client
	actionConfig := new(action.Configuration)
	if err := actionConfig.Init(
		settings.RESTClientGetter(),
		namespaceFilter,
		os.Getenv("HELM_DRIVER"),
		func(format string, v ...interface{}) {
			if os.Getenv("HELM_DEBUG") == "1" {
				fmt.Fprintf(os.Stderr, format+"\n", v...)
			}
		},
	); err != nil {
		fmt.Fprintf(os.Stderr, "Error initialising Helm: %v\n", err)
		os.Exit(1)
	}

	// List all releases
	listAction := action.NewList(actionConfig)
	if showAll || namespaceFilter == "" {
		listAction.AllNamespaces = true
	}
	listAction.All = true

	releases, err := listAction.Run()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error listing releases: %v\n", err)
		os.Exit(1)
	}

	var findings []AuditFinding

	for _, rel := range releases {
		manifests := splitManifests(rel.Manifest)
		for _, m := range manifests {
			var obj manifest
			if err := yaml.Unmarshal([]byte(m), &obj); err != nil {
				continue
			}
			if obj.APIVersion == "" || obj.Kind == "" {
				continue
			}

			// Check for deprecated API
			key := obj.APIVersion + "/" + obj.Kind
			if dep, found := deprecatedAPIs[key]; found {
				findings = append(findings, AuditFinding{
					Release:   rel.Name,
					Namespace: rel.Namespace,
					Resource:  obj.APIVersion + "/" + obj.Kind,
					Kind:      obj.Kind,
					Name:      obj.Metadata.Name,
					OldAPI:    dep.OldAPI,
					NewAPI:    dep.NewAPI,
					RemovedIn: dep.RemovedIn,
					Removed:   dep.Removed,
				})
			}
		}
	}

	switch outputFormat {
	case "json":
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(findings); err != nil {
			fmt.Fprintf(os.Stderr, "Error encoding JSON: %v\n", err)
			os.Exit(1)
		}
	case "text":
		if len(findings) == 0 {
			fmt.Println("No deprecated APIs found in any Helm release.")
			os.Exit(0)
		}
		w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
		fmt.Fprintln(w, "RELEASE\tNAMESPACE\tKIND\tNAME\tDEPRECATED API\tREPLACEMENT\tREMOVED IN\tSTATUS")
		for _, f := range findings {
			status := "deprecated"
			if f.Removed {
				status = "REMOVED"
			}
			fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n",
				f.Release, f.Namespace, f.Kind, f.Name,
				f.OldAPI, f.NewAPI, f.RemovedIn, status)
		}
		w.Flush()
		// Exit non-zero if removed APIs found (for CI blocking)
		for _, f := range findings {
			if f.Removed {
				os.Exit(2)
			}
		}
	default:
		fmt.Fprintf(os.Stderr, "Unknown output format: %s\n", outputFormat)
		os.Exit(1)
	}
}

func splitManifests(manifest string) []string {
	var result []string
	parts := strings.Split(manifest, "\n---")
	for _, p := range parts {
		trimmed := strings.TrimSpace(p)
		if trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result
}

func printUsage() {
	fmt.Print(`helm audit — audit Helm releases for deprecated Kubernetes APIs

Usage:
  helm audit [OPTIONS]

Options:
  -n, --namespace NAMESPACE  Namespace to audit (default: HELM_NAMESPACE)
  -A, --all-namespaces       Audit all namespaces
  -o, --output FORMAT        Output format: text|json (default: text)
  -h, --help                 Show this help

Exit codes:
  0   No deprecated APIs found
  1   Error occurred
  2   Removed APIs found (suitable for blocking CI)

Examples:
  helm audit -n production
  helm audit -A -o json | jq 'map(select(.already_removed))'
`)
}
```

### Goreleaser Configuration for Cross-Platform Builds

```yaml
# .goreleaser.yml
project_name: helm-audit
before:
  hooks:
    - go mod tidy

builds:
  - id: helm-audit
    main: .
    binary: bin/helm-audit
    goos: [linux, darwin, windows]
    goarch: [amd64, arm64]
    ldflags:
      - -s -w
      - -X main.version={{.Version}}
    env:
      - CGO_ENABLED=0

archives:
  - id: helm-audit-archive
    name_template: "helm-audit_{{ .Version }}_{{ .Os }}_{{ .Arch }}"
    files:
      - plugin.yaml
      - scripts/install-binary.sh
      - README.md

checksum:
  name_template: "checksums.txt"

release:
  github:
    owner: example-org
    name: helm-audit
```

### install-binary.sh for Go Plugin

```bash
#!/usr/bin/env bash
# scripts/install-binary.sh — download platform-specific binary on install/update
set -euo pipefail

PLUGIN_VERSION="1.3.0"
PLUGIN_DIR="${HELM_PLUGIN_DIR}"
BIN_DIR="${PLUGIN_DIR}/bin"
mkdir -p "${BIN_DIR}"

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "${ARCH}" in
  x86_64)  ARCH="amd64" ;;
  aarch64) ARCH="arm64" ;;
  arm64)   ARCH="arm64" ;;
  *)       echo "Unsupported architecture: ${ARCH}"; exit 1 ;;
esac

DOWNLOAD_URL="https://github.com/example-org/helm-audit/releases/download/v${PLUGIN_VERSION}/helm-audit_${PLUGIN_VERSION}_${OS}_${ARCH}.tar.gz"

echo "Downloading helm-audit v${PLUGIN_VERSION} for ${OS}/${ARCH}..."
curl -sSLo /tmp/helm-audit.tar.gz "${DOWNLOAD_URL}"
tar xzf /tmp/helm-audit.tar.gz -C /tmp helm-audit_${PLUGIN_VERSION}_${OS}_${ARCH}/bin/helm-audit
mv /tmp/helm-audit_${PLUGIN_VERSION}_${OS}_${ARCH}/bin/helm-audit "${BIN_DIR}/helm-audit"
chmod +x "${BIN_DIR}/helm-audit"
rm -rf /tmp/helm-audit.tar.gz /tmp/helm-audit_${PLUGIN_VERSION}_${OS}_${ARCH}

echo "helm-audit installed to ${BIN_DIR}/helm-audit"
```

## Accessing Helm Events via Hooks

Helm triggers plugin hooks at install, update, and delete lifecycle events. Hooks are specified in `plugin.yaml` and can perform environment setup, binary downloads, or cleanup:

```yaml
hooks:
  install: "$HELM_PLUGIN_DIR/scripts/install-binary.sh"
  update: "$HELM_PLUGIN_DIR/scripts/install-binary.sh"
  delete: "$HELM_PLUGIN_DIR/scripts/cleanup.sh"
```

A cleanup hook can remove downloaded binaries or revoke temporary credentials:

```bash
#!/usr/bin/env bash
# scripts/cleanup.sh
set -euo pipefail
echo "Cleaning up helm-audit..."
rm -rf "${HELM_PLUGIN_DIR}/bin"
echo "helm-audit uninstalled."
```

## Installing and Distributing Plugins

### Installing from a Local Directory

```bash
helm plugin install ./helm-audit/
```

### Installing from a Remote Git Repository

```bash
helm plugin install https://github.com/example-org/helm-audit --version 1.3.0
```

### Installing from an OCI Archive

Package the plugin as a tarball and host it on any HTTPS server or OCI registry:

```bash
tar czf helm-audit-1.3.0.tar.gz helm-audit/
helm plugin install https://releases.example.com/helm-plugins/helm-audit-1.3.0.tar.gz
```

### Updating and Removing Plugins

```bash
# Update to latest version
helm plugin update audit

# Remove plugin
helm plugin uninstall audit

# List installed plugins
helm plugin list
```

## CI Integration

### GitHub Actions Workflow Using helm-audit

```yaml
name: Helm Deprecation Audit

on:
  pull_request:
    paths:
      - "charts/**"
      - "helm/**"

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install Helm
        uses: azure/setup-helm@v4
        with:
          version: "3.14.0"

      - name: Install helm-audit plugin
        run: |
          helm plugin install https://github.com/example-org/helm-audit \
            --version 1.3.0

      - name: Configure kubeconfig
        run: |
          mkdir -p ~/.kube
          echo "${{ secrets.STAGING_KUBECONFIG }}" > ~/.kube/config
          chmod 600 ~/.kube/config

      - name: Audit releases for deprecated APIs
        id: audit
        run: |
          set +e
          OUTPUT=$(helm audit -A -o json 2>&1)
          EXIT_CODE=$?
          echo "findings=${OUTPUT}" >> "${GITHUB_OUTPUT}"
          exit ${EXIT_CODE}

      - name: Post audit results to PR
        if: always()
        uses: actions/github-script@v7
        with:
          script: |
            const findings = JSON.parse('${{ steps.audit.outputs.findings }}' || '[]');
            if (findings.length === 0) {
              await github.rest.issues.createComment({
                issue_number: context.issue.number,
                owner: context.repo.owner,
                repo: context.repo.repo,
                body: 'Helm audit passed: no deprecated APIs found.'
              });
              return;
            }
            const rows = findings.map(f =>
              `| ${f.release} | ${f.namespace} | ${f.kind} | ${f.deprecated_api} | ${f.removed_in_version} | ${f.already_removed ? 'REMOVED' : 'deprecated'} |`
            ).join('\n');
            const body = `## Helm Deprecated API Audit\n\n| Release | Namespace | Kind | Deprecated API | Removed In | Status |\n|---|---|---|---|---|---|\n${rows}`;
            await github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: body
            });
```

### Using helm-diff-summary in a Deployment Pipeline

```yaml
name: Deploy to Staging

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - uses: actions/checkout@v4

      - name: Install Helm and plugins
        run: |
          curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
          helm plugin install https://github.com/databus23/helm-diff --version 3.9.4
          helm plugin install ./plugins/helm-diff-summary

      - name: Preview changes
        id: preview
        run: |
          SUMMARY=$(helm diff-summary \
            -n staging \
            -o markdown \
            --values deploy/staging-values.yaml \
            app-service ./charts/app-service)
          echo "summary<<HEREDOC" >> "${GITHUB_OUTPUT}"
          echo "${SUMMARY}" >> "${GITHUB_OUTPUT}"
          echo "HEREDOC" >> "${GITHUB_OUTPUT}"

      - name: Post diff summary
        uses: actions/github-script@v7
        with:
          script: |
            await github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: `${{ steps.preview.outputs.summary }}`
            });

      - name: Deploy
        run: |
          helm upgrade --install app-service ./charts/app-service \
            -n staging \
            --values deploy/staging-values.yaml \
            --atomic \
            --timeout 5m
```

## Plugin Testing

### Shell Plugin Testing with bats

```shell
#!/usr/bin/env bats
# tests/diff-summary.bats

setup() {
  # Create a temporary plugin directory
  export HELM_PLUGIN_DIR="${BATS_TMPDIR}/helm-diff-summary"
  mkdir -p "${HELM_PLUGIN_DIR}/scripts"
  cp scripts/diff-summary.sh "${HELM_PLUGIN_DIR}/scripts/"
  chmod +x "${HELM_PLUGIN_DIR}/scripts/diff-summary.sh"

  export HELM_NAMESPACE="test"
  export HELM_KUBECONTEXT="test-context"
}

@test "shows usage on --help" {
  run "${HELM_PLUGIN_DIR}/scripts/diff-summary.sh" --help
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"helm diff-summary"* ]]
}

@test "fails with no arguments" {
  run "${HELM_PLUGIN_DIR}/scripts/diff-summary.sh"
  [ "${status}" -eq 1 ]
  [[ "${output}" == *"RELEASE and CHART are required"* ]]
}

@test "validates output format" {
  run "${HELM_PLUGIN_DIR}/scripts/diff-summary.sh" \
    -o invalid-format my-release ./chart
  [ "${status}" -eq 1 ]
  [[ "${output}" == *"unknown output format"* ]]
}
```

### Go Plugin Testing

```go
// main_test.go
package main

import (
	"strings"
	"testing"
)

func TestSplitManifests(t *testing.T) {
	input := `apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-app
---
apiVersion: v1
kind: Service
metadata:
  name: test-svc`

	manifests := splitManifests(input)
	if len(manifests) != 2 {
		t.Errorf("expected 2 manifests, got %d", len(manifests))
	}
}

func TestDeprecatedAPIDetection(t *testing.T) {
	testCases := []struct {
		apiVersion string
		kind       string
		expectHit  bool
	}{
		{"extensions/v1beta1", "Ingress", true},
		{"networking.k8s.io/v1", "Ingress", false},
		{"policy/v1beta1", "PodSecurityPolicy", true},
		{"apps/v1", "Deployment", false},
	}

	for _, tc := range testCases {
		key := tc.apiVersion + "/" + tc.kind
		_, found := deprecatedAPIs[key]
		if found != tc.expectHit {
			t.Errorf("key %s: expected found=%v, got found=%v", key, tc.expectHit, found)
		}
	}
}

func TestOutputFormatValidation(t *testing.T) {
	validFormats := []string{"text", "json"}
	for _, f := range validFormats {
		if !strings.Contains("text json", f) {
			t.Errorf("format %s should be valid", f)
		}
	}
}
```

## Notable Ecosystem Plugins

The Helm plugin ecosystem includes mature, widely-adopted tools worth studying for implementation patterns:

- **helm-diff** (databus23): Shows a diff between the deployed release and a proposed upgrade. Uses the Helm Go SDK to decode stored manifests and perform three-way merge.
- **helm-secrets** (jkroepke): Transparent encryption/decryption of secret values using SOPS, Vault, or Age. Wraps helm subcommands by intercepting the command arguments, decrypting values files in a temporary directory, and cleaning up after.
- **helm-unittest**: Snapshot and assertion testing for chart templates. Implements a full test runner as a Go binary with YAML-based test specs.
- **helm-mapkubeapis**: Migrates release metadata in the Helm store to use current API versions, enabling upgrades after deprecated APIs are removed from a cluster.

## Summary

Helm plugins are a lightweight but powerful extension mechanism. The `plugin.yaml` contract, combined with the set of `HELM_*` environment variables, provides sufficient integration surface for plugins ranging from simple shell wrappers to full Go binaries using the Helm SDK. The `helm-audit` plugin demonstrated here provides genuine operational value—detecting deprecated API usage before it causes upgrade failures—while the `helm-diff-summary` plugin closes a common gap in PR automation workflows. Both patterns are directly extensible to custom enterprise requirements: environment-specific policy checks, cost estimation, compliance reporting, or automated runbook generation.
