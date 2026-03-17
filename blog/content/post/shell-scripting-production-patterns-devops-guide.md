---
title: "Production Shell Scripting Patterns for DevOps Engineers"
date: 2028-09-20T00:00:00-05:00
draft: false
tags: ["Shell Scripting", "Bash", "DevOps", "Automation", "Linux"]
categories:
- Shell Scripting
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Production bash scripting — strict mode, trap cleanup, lockfiles, signal handling, idempotent scripts, argument parsing, logging functions, retry loops, parallel execution, secret handling, heredocs, and testing with bats."
more_link: "yes"
url: "/shell-scripting-production-patterns-devops-guide/"
---

Shell scripts live forever. The deployment script someone wrote in 2018 to "just get this done" is still running in production in 2028. It has no error handling, uses unquoted variables that break on paths with spaces, and makes no attempt to clean up after itself when interrupted. Every DevOps engineer has encountered this pattern, and many have continued it. This guide documents the patterns that distinguish scripts that can be trusted in production from those that create incidents. The investment in writing them correctly the first time pays dividends for as long as the script runs — which is always longer than you expect.

<!--more-->

# Production Shell Scripting Patterns for DevOps Engineers

## Section 1: Strict Mode — The Non-Negotiable Foundation

Every production script starts with this header:

```bash
#!/usr/bin/env bash
# Script: deploy-service.sh
# Description: Deploy a service to Kubernetes
# Usage: deploy-service.sh [OPTIONS] <service-name> <version>
# Author: mmattox@support.tools
# Version: 2.3.1

set -euo pipefail
IFS=$'\n\t'
```

What each flag does:

- `set -e`: Exit immediately if any command exits with a non-zero status. Without this, the script continues after failures and can leave systems in an inconsistent state.
- `set -u`: Treat unset variables as an error. Catches typos like `${SERIVCE_NAME}` that would silently expand to empty string.
- `set -o pipefail`: A pipeline's exit status is the exit status of the last command to exit with non-zero status. Without this, `cat file | grep pattern | wc -l` returns 0 even if `cat` fails.
- `IFS=$'\n\t'`: Change the Internal Field Separator from space/tab/newline to just tab/newline. Prevents word splitting on spaces in filenames and loop variables.

### Why IFS Matters

```bash
# WITHOUT IFS change — dangerous
FILES=$(ls /data)
for f in $FILES; do     # Breaks on filenames with spaces
    process_file "$f"
done

# WITH IFS=$'\n\t' — safer
# But the correct pattern is:
while IFS= read -r -d '' f; do
    process_file "$f"
done < <(find /data -type f -print0)
```

## Section 2: Signal Handling and Cleanup with trap

Without cleanup, interrupted scripts leave lockfiles, temporary directories, and in-progress operations that must be manually investigated.

```bash
#!/usr/bin/env bash
set -euo pipefail

# === Globals ===
readonly SCRIPT_NAME="$(basename "$0")"
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
readonly TMP_DIR="$(mktemp -d -t "${SCRIPT_NAME}.XXXXXX")"
readonly LOG_FILE="/var/log/${SCRIPT_NAME%-sh}-${TIMESTAMP}.log"
LOCK_FILE=""

# === Cleanup Handler ===
cleanup() {
    local exit_code=$?
    local line_number=${BASH_LINENO[0]}

    # Always remove temp directory
    if [[ -d "${TMP_DIR}" ]]; then
        rm -rf "${TMP_DIR}"
    fi

    # Release lockfile if we hold it
    if [[ -n "${LOCK_FILE}" ]] && [[ -f "${LOCK_FILE}" ]]; then
        rm -f "${LOCK_FILE}"
    fi

    if [[ ${exit_code} -ne 0 ]]; then
        log_error "Script failed at line ${line_number} with exit code ${exit_code}"
        log_error "Check ${LOG_FILE} for details"
    else
        log_info "Script completed successfully"
    fi

    exit "${exit_code}"
}

# Register cleanup for all exit scenarios
trap cleanup EXIT
trap 'cleanup; exit 130' INT    # Ctrl+C
trap 'cleanup; exit 143' TERM   # kill

# Register error handler with line number
trap 'log_error "Error at line ${LINENO}: ${BASH_COMMAND}"' ERR
```

## Section 3: Logging Framework

```bash
# === Logging ===
# Colors only when stdout is a terminal
if [[ -t 1 ]]; then
    readonly COLOR_RED='\033[0;31m'
    readonly COLOR_YELLOW='\033[1;33m'
    readonly COLOR_GREEN='\033[0;32m'
    readonly COLOR_BLUE='\033[0;34m'
    readonly COLOR_NC='\033[0m'
else
    readonly COLOR_RED=''
    readonly COLOR_YELLOW=''
    readonly COLOR_GREEN=''
    readonly COLOR_BLUE=''
    readonly COLOR_NC=''
fi

log_timestamp() {
    date '+%Y-%m-%d %H:%M:%S'
}

log_info() {
    local message="$*"
    printf '%b[INFO]%b  %s %s\n' "${COLOR_GREEN}" "${COLOR_NC}" "$(log_timestamp)" "${message}" | tee -a "${LOG_FILE}"
}

log_warn() {
    local message="$*"
    printf '%b[WARN]%b  %s %s\n' "${COLOR_YELLOW}" "${COLOR_NC}" "$(log_timestamp)" "${message}" | tee -a "${LOG_FILE}" >&2
}

log_error() {
    local message="$*"
    printf '%b[ERROR]%b %s %s\n' "${COLOR_RED}" "${COLOR_NC}" "$(log_timestamp)" "${message}" | tee -a "${LOG_FILE}" >&2
}

log_debug() {
    local message="$*"
    if [[ "${DEBUG:-false}" == "true" ]]; then
        printf '%b[DEBUG]%b %s %s\n' "${COLOR_BLUE}" "${COLOR_NC}" "$(log_timestamp)" "${message}" | tee -a "${LOG_FILE}"
    fi
}

log_section() {
    local title="$*"
    printf '\n%b=== %s ===%b\n' "${COLOR_BLUE}" "${title}" "${COLOR_NC}" | tee -a "${LOG_FILE}"
}
```

## Section 4: Lockfiles — Preventing Concurrent Runs

```bash
# === Lockfile Management ===
acquire_lock() {
    local lock_dir="${1:-/tmp}"
    local lock_name="${2:-${SCRIPT_NAME}}"
    LOCK_FILE="${lock_dir}/${lock_name}.lock"

    # Use a lock directory instead of a file for atomicity
    # mkdir is atomic on Linux ext4/xfs
    local lock_dir_path="${LOCK_FILE}.d"

    if ! mkdir "${lock_dir_path}" 2>/dev/null; then
        # Check if the holding process is still alive
        local holding_pid=""
        if [[ -f "${LOCK_FILE}" ]]; then
            holding_pid=$(cat "${LOCK_FILE}" 2>/dev/null || echo "")
        fi

        if [[ -n "${holding_pid}" ]] && kill -0 "${holding_pid}" 2>/dev/null; then
            log_error "Another instance of ${SCRIPT_NAME} is running (PID ${holding_pid})"
            log_error "Lock file: ${LOCK_FILE}"
            exit 1
        else
            log_warn "Found stale lockfile from PID ${holding_pid:-unknown}, removing..."
            rm -rf "${lock_dir_path}"
            mkdir "${lock_dir_path}"
        fi
    fi

    # Write our PID to the lock file
    echo $$ > "${LOCK_FILE}"
    log_debug "Acquired lock: ${LOCK_FILE}"
}

release_lock() {
    if [[ -n "${LOCK_FILE}" ]]; then
        rm -f "${LOCK_FILE}"
        rm -rf "${LOCK_FILE}.d"
        log_debug "Released lock: ${LOCK_FILE}"
    fi
}
```

## Section 5: Argument Parsing with getopt

```bash
# === Argument Parsing ===
usage() {
    cat <<EOF
Usage: ${SCRIPT_NAME} [OPTIONS] <service-name> <version>

Deploy a service to a Kubernetes environment.

Arguments:
  service-name    Name of the service to deploy (e.g., payments-api)
  version         Docker image tag to deploy (e.g., 1.4.2)

Options:
  -e, --environment ENV      Target environment (dev|staging|production) [default: staging]
  -n, --namespace NS         Kubernetes namespace [default: derived from environment]
  -d, --dry-run              Print what would be done without executing
  -f, --force                Skip confirmation prompts
  -t, --timeout SECONDS      Deployment timeout in seconds [default: 300]
      --rollback             Rollback to the previous deployment
  -v, --verbose              Enable verbose output
  -h, --help                 Show this help message

Examples:
  ${SCRIPT_NAME} payments-api 1.4.2
  ${SCRIPT_NAME} --environment production --dry-run payments-api 1.4.2
  ${SCRIPT_NAME} --rollback payments-api

Environment Variables:
  KUBECONFIG        Path to kubeconfig file
  HELM_HOME         Helm home directory
  DEBUG             Enable debug logging (true|false)
EOF
}

parse_args() {
    # Use getopt for long option support
    if ! OPTS=$(getopt \
        --options e:n:dft:vh \
        --longoptions environment:,namespace:,dry-run,force,timeout:,rollback,verbose,help \
        --name "${SCRIPT_NAME}" \
        -- "$@"); then
        log_error "Failed to parse arguments"
        usage
        exit 1
    fi

    eval set -- "${OPTS}"

    # Defaults
    ENVIRONMENT="staging"
    NAMESPACE=""
    DRY_RUN=false
    FORCE=false
    TIMEOUT=300
    ROLLBACK=false
    VERBOSE=false

    while true; do
        case "$1" in
            -e|--environment)
                ENVIRONMENT="$2"
                shift 2
                ;;
            -n|--namespace)
                NAMESPACE="$2"
                shift 2
                ;;
            -d|--dry-run)
                DRY_RUN=true
                shift
                ;;
            -f|--force)
                FORCE=true
                shift
                ;;
            -t|--timeout)
                TIMEOUT="$2"
                shift 2
                ;;
            --rollback)
                ROLLBACK=true
                shift
                ;;
            -v|--verbose)
                VERBOSE=true
                export DEBUG=true
                shift
                ;;
            -h|--help)
                usage
                exit 0
                ;;
            --)
                shift
                break
                ;;
        esac
    done

    # Remaining positional arguments
    if [[ ${ROLLBACK} == false ]]; then
        if [[ $# -lt 2 ]]; then
            log_error "Missing required arguments: <service-name> <version>"
            usage
            exit 1
        fi
        SERVICE_NAME="$1"
        VERSION="$2"
    elif [[ $# -lt 1 ]]; then
        log_error "Missing required argument: <service-name>"
        usage
        exit 1
    else
        SERVICE_NAME="$1"
        VERSION=""
    fi

    # Validate environment
    case "${ENVIRONMENT}" in
        dev|staging|production) ;;
        *)
            log_error "Invalid environment: ${ENVIRONMENT}. Must be dev, staging, or production."
            exit 1
            ;;
    esac

    # Derive namespace from environment if not specified
    if [[ -z "${NAMESPACE}" ]]; then
        NAMESPACE="${SERVICE_NAME}"
    fi

    readonly ENVIRONMENT NAMESPACE DRY_RUN FORCE TIMEOUT ROLLBACK VERBOSE
    readonly SERVICE_NAME VERSION
}
```

## Section 6: Retry Loops with Exponential Backoff

```bash
# === Retry Logic ===
# retry <max_attempts> <initial_delay> <command...>
# Retries a command with exponential backoff.
# Returns 0 on success, 1 if all attempts fail.
retry() {
    local max_attempts="$1"
    local initial_delay="$2"
    shift 2
    local cmd=("$@")

    local attempt=1
    local delay="${initial_delay}"

    while [[ ${attempt} -le ${max_attempts} ]]; do
        log_debug "Attempt ${attempt}/${max_attempts}: ${cmd[*]}"

        if "${cmd[@]}"; then
            return 0
        fi

        local exit_code=$?

        if [[ ${attempt} -eq ${max_attempts} ]]; then
            log_error "All ${max_attempts} attempts failed for: ${cmd[*]}"
            return ${exit_code}
        fi

        log_warn "Attempt ${attempt} failed (exit code ${exit_code}). Retrying in ${delay}s..."
        sleep "${delay}"

        # Exponential backoff with jitter
        delay=$(( delay * 2 + RANDOM % delay + 1 ))
        # Cap at 60 seconds
        if [[ ${delay} -gt 60 ]]; then
            delay=60
        fi

        (( attempt++ ))
    done
}

# wait_for <timeout> <interval> <description> <condition_command...>
# Polls a condition until it succeeds or times out.
wait_for() {
    local timeout="$1"
    local interval="$2"
    local description="$3"
    shift 3
    local condition=("$@")

    local start_time
    start_time=$(date +%s)
    local deadline=$(( start_time + timeout ))

    log_info "Waiting for: ${description} (timeout: ${timeout}s)"

    while true; do
        if "${condition[@]}" &>/dev/null; then
            log_info "${description}: ready"
            return 0
        fi

        local now
        now=$(date +%s)
        if [[ ${now} -ge ${deadline} ]]; then
            log_error "Timeout waiting for: ${description}"
            return 1
        fi

        local remaining=$(( deadline - now ))
        log_debug "Not ready yet (${remaining}s remaining). Sleeping ${interval}s..."
        sleep "${interval}"
    done
}

# Usage examples:
# retry 5 2 curl -sf https://api.example.com/health
# wait_for 120 5 "Kubernetes deployment rollout" \
#   kubectl rollout status deployment/payments-api -n payments
```

## Section 7: Parallel Execution

```bash
# === Parallel Job Runner ===
# run_parallel <max_parallel> command_array_name
# Runs commands in parallel, respecting max_parallel limit.
# Collects exit codes and reports failures.
run_parallel() {
    local max_parallel="$1"
    local -n commands_ref="$2"  # nameref — requires bash 4.3+

    local pids=()
    local cmd_names=()
    local failed=0
    local running=0

    for cmd in "${commands_ref[@]}"; do
        # Wait if at capacity
        while [[ ${running} -ge ${max_parallel} ]]; do
            for i in "${!pids[@]}"; do
                if ! kill -0 "${pids[$i]}" 2>/dev/null; then
                    wait "${pids[$i]}"
                    local exit_code=$?
                    if [[ ${exit_code} -ne 0 ]]; then
                        log_error "Job '${cmd_names[$i]}' failed with exit code ${exit_code}"
                        (( failed++ ))
                    fi
                    unset 'pids[$i]'
                    unset 'cmd_names[$i]'
                    (( running-- ))
                fi
            done
            [[ ${running} -ge ${max_parallel} ]] && sleep 0.1
        done

        # Launch the job
        log_debug "Starting: ${cmd}"
        eval "${cmd}" &
        pids+=($!)
        cmd_names+=("${cmd:0:60}")
        (( running++ ))
    done

    # Wait for remaining jobs
    for i in "${!pids[@]}"; do
        wait "${pids[$i]}"
        local exit_code=$?
        if [[ ${exit_code} -ne 0 ]]; then
            log_error "Job '${cmd_names[$i]}' failed with exit code ${exit_code}"
            (( failed++ ))
        fi
    done

    if [[ ${failed} -gt 0 ]]; then
        log_error "${failed} parallel jobs failed"
        return 1
    fi

    return 0
}

# Example: deploy to multiple regions in parallel
deploy_to_regions() {
    local service="$1"
    local version="$2"

    local deploy_cmds=(
        "helm upgrade --install ${service} ./chart -n ${service} --kube-context us-east-1 --set image.tag=${version}"
        "helm upgrade --install ${service} ./chart -n ${service} --kube-context eu-west-1 --set image.tag=${version}"
        "helm upgrade --install ${service} ./chart -n ${service} --kube-context ap-southeast-1 --set image.tag=${version}"
    )

    log_section "Deploying ${service}:${version} to all regions"
    run_parallel 3 deploy_cmds
}
```

## Section 8: Secret Handling

```bash
# === Secrets Management ===
# NEVER store secrets in variables if avoidable.
# Use command substitution that reads from secure sources.

# Read from AWS Secrets Manager
get_secret_aws() {
    local secret_name="$1"
    local key="${2:-}"

    local json
    json=$(aws secretsmanager get-secret-value \
        --secret-id "${secret_name}" \
        --query SecretString \
        --output text 2>/dev/null) || {
        log_error "Failed to retrieve secret: ${secret_name}"
        return 1
    }

    if [[ -n "${key}" ]]; then
        echo "${json}" | jq -r ".${key}"
    else
        echo "${json}"
    fi
}

# Read from HashiCorp Vault
get_secret_vault() {
    local path="$1"
    local key="$2"

    vault kv get -field="${key}" "${path}" 2>/dev/null || {
        log_error "Failed to retrieve secret from Vault: ${path}#${key}"
        return 1
    }
}

# Read from Kubernetes secret
get_k8s_secret() {
    local namespace="$1"
    local secret_name="$2"
    local key="$3"

    kubectl get secret "${secret_name}" \
        --namespace "${namespace}" \
        -o jsonpath="{.data.${key}}" \
        | base64 -d
}

# Safe credential usage — never echo/log secrets
perform_authenticated_request() {
    local api_url="$1"
    local endpoint="$2"

    # Get token directly into curl without storing in variable
    local http_code
    http_code=$(curl -sf \
        -H "Authorization: Bearer $(get_secret_aws "prod/api-tokens" "api_token")" \
        -o /dev/null \
        -w "%{http_code}" \
        "${api_url}${endpoint}")

    if [[ "${http_code}" -ne 200 ]]; then
        log_error "API request failed with status ${http_code}"
        return 1
    fi
}
```

## Section 9: Idempotent Operations

```bash
# === Idempotency Patterns ===

# Create resource only if it doesn't exist
ensure_namespace() {
    local namespace="$1"
    if ! kubectl get namespace "${namespace}" &>/dev/null; then
        log_info "Creating namespace: ${namespace}"
        kubectl create namespace "${namespace}"
    else
        log_debug "Namespace already exists: ${namespace}"
    fi
}

# Apply with server-side apply for idempotency
apply_manifest() {
    local manifest_file="$1"
    local dry_run="${2:-false}"

    local extra_args=()
    if [[ "${dry_run}" == "true" ]]; then
        extra_args+=(--dry-run=server)
    fi

    kubectl apply \
        --server-side \
        --field-manager "${SCRIPT_NAME}" \
        "${extra_args[@]}" \
        -f "${manifest_file}"
}

# State file for tracking what has been done
mark_done() {
    local step_name="$1"
    local state_file="${TMP_DIR}/completed_steps"
    echo "${step_name}" >> "${state_file}"
}

is_done() {
    local step_name="$1"
    local state_file="${TMP_DIR}/completed_steps"
    grep -qxF "${step_name}" "${state_file}" 2>/dev/null
}

# Usage:
# if ! is_done "migrate-database"; then
#     run_migration
#     mark_done "migrate-database"
# fi
```

## Section 10: Testing Bash Scripts with bats

```bash
# Install bats-core
git clone https://github.com/bats-core/bats-core.git /tmp/bats-core
/tmp/bats-core/install.sh /usr/local

# Install test helpers
git clone https://github.com/bats-core/bats-support.git test/test_helper/bats-support
git clone https://github.com/bats-core/bats-assert.git test/test_helper/bats-assert
git clone https://github.com/bats-core/bats-file.git test/test_helper/bats-file
```

```bash
#!/usr/bin/env bats
# test/deploy-service.bats — unit tests for deploy-service.sh

load 'test_helper/bats-support/load'
load 'test_helper/bats-assert/load'
load 'test_helper/bats-file/load'

# Setup — runs before each test
setup() {
    # Source only the library functions, not the main() call
    source "${BATS_TEST_DIRNAME}/../lib/logging.sh"
    source "${BATS_TEST_DIRNAME}/../lib/utils.sh"

    # Create a temp directory for this test
    TEST_TMP=$(mktemp -d)
    export LOG_FILE="${TEST_TMP}/test.log"
}

# Teardown — runs after each test
teardown() {
    rm -rf "${TEST_TMP}"
}

@test "retry succeeds on first attempt" {
    run retry 3 1 true
    assert_success
}

@test "retry exhausts all attempts and fails" {
    run retry 3 0 false
    assert_failure
}

@test "retry succeeds after temporary failure" {
    # Create a script that fails twice then succeeds
    local counter_file="${TEST_TMP}/counter"
    echo 0 > "${counter_file}"

    flaky_command() {
        local count
        count=$(cat "${counter_file}")
        count=$(( count + 1 ))
        echo "${count}" > "${counter_file}"
        [[ ${count} -ge 3 ]]
    }

    export -f flaky_command
    run retry 5 0 bash -c "flaky_command"
    assert_success
}

@test "log_info writes to log file" {
    log_info "test message"
    assert_file_exists "${LOG_FILE}"
    run grep "test message" "${LOG_FILE}"
    assert_success
}

@test "log_info includes timestamp" {
    log_info "timestamp test"
    run grep -E '\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}' "${LOG_FILE}"
    assert_success
}

@test "ensure_namespace is idempotent" {
    # Mock kubectl
    kubectl() {
        case "$1" in
            get)   return 0 ;;  # Namespace exists
            *)     fail "Unexpected kubectl call: $*" ;;
        esac
    }
    export -f kubectl

    run ensure_namespace "test-ns"
    assert_success
    # Should not call 'kubectl create'
    refute_output --partial "Creating namespace"
}

@test "get_k8s_secret decodes base64" {
    # Mock kubectl to return base64-encoded value
    kubectl() {
        echo "c2VjcmV0dmFsdWU="  # base64 of "secretvalue"
    }
    export -f kubectl

    result=$(get_k8s_secret "default" "mysecret" "password")
    assert_equal "${result}" "secretvalue"
}

@test "parse_args sets defaults" {
    parse_args payments-api 1.4.2
    assert_equal "${ENVIRONMENT}" "staging"
    assert_equal "${DRY_RUN}" "false"
    assert_equal "${TIMEOUT}" "300"
}

@test "parse_args validates environment" {
    run parse_args --environment invalid-env payments-api 1.4.2
    assert_failure
    assert_output --partial "Invalid environment"
}

@test "run_parallel collects failures" {
    local cmds=(
        "true"
        "false"
        "true"
    )
    run run_parallel 3 cmds
    assert_failure
}
```

```bash
# Makefile target for running tests
test:
    bats test/

test-watch:
    bats --tap test/ | tee test-results.tap

# Run with coverage (requires kcov)
test-coverage:
    kcov --include-pattern=.sh coverage/ bats test/
```

## Section 11: A Complete Production Script

```bash
#!/usr/bin/env bash
# deploy-service.sh — production deployment script implementing all patterns above
set -euo pipefail
IFS=$'\n\t'

readonly SCRIPT_NAME="$(basename "$0")"
readonly SCRIPT_VERSION="2.3.1"
readonly TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
readonly TMP_DIR="$(mktemp -d -t "${SCRIPT_NAME}.XXXXXX")"
readonly LOG_FILE="/var/log/deployments/${SCRIPT_NAME%-sh}-${TIMESTAMP}.log"
LOCK_FILE=""

# Source library functions
# shellcheck source=lib/logging.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/logging.sh"
# shellcheck source=lib/utils.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/utils.sh"

cleanup() {
    local exit_code=$?
    [[ -d "${TMP_DIR}" ]] && rm -rf "${TMP_DIR}"
    [[ -n "${LOCK_FILE}" ]] && rm -f "${LOCK_FILE}" "${LOCK_FILE}.d"
    [[ ${exit_code} -ne 0 ]] && log_error "Deployment failed. Check ${LOG_FILE}"
    exit "${exit_code}"
}

trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM
trap 'log_error "Error at line ${LINENO}: ${BASH_COMMAND}"' ERR

main() {
    mkdir -p "$(dirname "${LOG_FILE}")"
    parse_args "$@"
    acquire_lock /tmp "${SCRIPT_NAME}-${SERVICE_NAME}"

    log_section "Deployment: ${SERVICE_NAME}:${VERSION} -> ${ENVIRONMENT}"
    log_info "Script version: ${SCRIPT_VERSION}"
    log_info "Log file: ${LOG_FILE}"

    # Confirmation for production
    if [[ "${ENVIRONMENT}" == "production" ]] && [[ "${FORCE}" != "true" ]]; then
        read -rp "Deploy ${SERVICE_NAME}:${VERSION} to PRODUCTION? [yes/no]: " confirm
        [[ "${confirm}" != "yes" ]] && { log_info "Deployment cancelled."; exit 0; }
    fi

    if [[ "${DRY_RUN}" == "true" ]]; then
        log_warn "DRY RUN MODE — no changes will be made"
    fi

    # Pre-flight checks
    log_section "Pre-flight Checks"
    retry 3 2 kubectl cluster-info --context "${ENVIRONMENT}" &>/dev/null || {
        log_error "Cannot connect to ${ENVIRONMENT} cluster"
        exit 1
    }

    ensure_namespace "${NAMESPACE}"

    # Run deployment
    log_section "Deploying"
    local helm_args=(
        upgrade --install "${SERVICE_NAME}"
        "./charts/${SERVICE_NAME}"
        --namespace "${NAMESPACE}"
        --kube-context "${ENVIRONMENT}"
        --set "image.tag=${VERSION}"
        --set "environment=${ENVIRONMENT}"
        --timeout "${TIMEOUT}s"
        --atomic
        --wait
    )

    if [[ "${DRY_RUN}" == "true" ]]; then
        helm_args+=(--dry-run)
    fi

    if [[ "${VERBOSE}" == "true" ]]; then
        helm_args+=(--debug)
    fi

    helm "${helm_args[@]}"

    # Verify deployment
    log_section "Verification"
    wait_for "${TIMEOUT}" 10 "Deployment rollout" \
        kubectl rollout status "deployment/${SERVICE_NAME}" \
        --namespace "${NAMESPACE}" \
        --context "${ENVIRONMENT}"

    log_info "Deployment successful: ${SERVICE_NAME}:${VERSION} in ${ENVIRONMENT}"
}

main "$@"
```

## Conclusion

Production shell scripts are not about cleverness — they are about predictability, debuggability, and operational safety. The patterns in this guide are not exotic; they are the distillation of what separates scripts that create confidence from scripts that create incidents. Use strict mode without exception, implement cleanup traps before writing any operational code, log to files with timestamps, acquire locks for anything that should not run concurrently, and write tests with bats before the script is in production. The 30 extra minutes spent implementing these patterns correctly will save hours of debugging at 2 AM when something fails in an unexpected way.
