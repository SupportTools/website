---
title: "Self-Hosted Coding Agents on Kubernetes: Running Pi, Claude Code, and Cline Against Your Own Inference Cluster"
date: 2026-07-25T00:00:00-05:00
draft: false
tags: ["ai-assisted-development", "coding-agents", "kubernetes", "vllm", "litellm", "self-hosted", "llm", "gpu", "pi-agent", "claude-code", "open-weight-models", "devops"]
categories:
- AI/ML
- Kubernetes
- Developer Tools
author: "Matthew Mattox - mmattox@support.tools"
description: "Run coding agents inside your own cluster. Serve open-weight models with vLLM on Kubernetes, front them with a LiteLLM gateway, and point Pi, Claude Code, Cline, and Aider at self-hosted endpoints."
more_link: "yes"
url: "/self-hosted-coding-agents-kubernetes-vllm-litellm-enterprise-guide/"
---

Every agentic coding session ships source code to a third party. An agent that reads forty files to answer one question has transmitted forty files, and the enterprises that care about this are discovering an uncomfortable detail: the coding agent is not the problem. Every major agent CLI in 2026 is a protocol client that accepts a custom endpoint. The model is the only part that has to be somewhere else, and open-weight models now clear 70-80% on SWE-bench Verified under MIT and Apache 2.0 licenses. The infrastructure to keep the entire loop inside a cluster boundary already exists.

<!--more-->

## Why Self-Host the Agent Layer

The case for running agents against internal inference splits into four distinct arguments, and only one of them is about cost.

**Source code egress** is the forcing function for most regulated organizations. A coding agent operating in a repository does not send a carefully scoped snippet. It greps, it reads, it expands context, and by the end of a debugging session a substantial fraction of a proprietary codebase has crossed the network boundary. Vendor zero-retention agreements mitigate the storage question but not the transmission question, and for organizations operating under ITAR, CJIS, or contractual source-escrow terms, transmission itself is the controlled event.

**Auditability** follows directly. When inference runs on infrastructure the organization controls, every request is loggable at the gateway with full prompt and completion bodies, attributable to an authenticated identity, and retained under the organization's own policy. That is a materially different posture from parsing a vendor's usage dashboard.

**Model pinning** matters more than it appears. Hosted model endpoints change underneath consumers. A prompt engineered against one snapshot behaves differently three months later, and agent harnesses are unusually sensitive to this because they depend on consistent tool-calling behavior across long multi-turn loops. Self-hosted weights do not drift. The version deployed is the version running until someone deliberately changes it.

**Cost** is the weakest argument and deserves honest treatment, covered in its own section below. Self-hosting rarely saves money below a few hundred developers.

## Reference Architecture

The full stack has four layers, and the meaningful engineering work sits in the middle two:

```
┌─────────────────────────────────────────────────────────────┐
│  Developer Workstations                                     │
│                                                             │
│   pi          claude        cline         aider             │
│    │            │             │             │               │
│    │ OpenAI     │ Anthropic   │ OpenAI      │ OpenAI        │
│    │ /v1/chat   │ /v1/messages│ /v1/chat    │ /v1/chat      │
└────┼────────────┼─────────────┼─────────────┼───────────────┘
     │            │             │             │
     └────────────┴──────┬──────┴─────────────┘
                         │  mTLS / bearer token
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  LiteLLM Gateway            namespace: ai-platform          │
│                                                             │
│   • Protocol translation  (/v1/messages → /v1/chat/...)     │
│   • Virtual keys, per-team spend attribution                │
│   • Model routing and fallback                              │
│   • Request/response audit logging                          │
└──────────────────────────┬──────────────────────────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
┌───────────────┐  ┌───────────────┐  ┌───────────────┐
│ vLLM          │  │ vLLM          │  │ vLLM          │
│ qwen3-coder   │  │ devstral-2    │  │ qwen3-small   │
│ 2x A100 80GB  │  │ 2x A100 80GB  │  │ 1x L40S       │
│ (reasoning)   │  │ (reasoning)   │  │ (bulk edits)  │
└───────────────┘  └───────────────┘  └───────────────┘
        │                  │                  │
        └──────────────────┴──────────────────┘
                           │
                  ┌────────────────────┐
                  │ NVIDIA GPU Operator│
                  │ node pool: gpu-a100│
                  └────────────────────┘
```

Two paths exist from agent to model. The direct path skips the gateway entirely and points agents at a vLLM Service. It is simpler and appropriate for a single team running a single model. The gateway path is required the moment a client speaks a protocol vLLM does not serve, or the moment anyone asks which team spent what.

## Hardware and Cost Reality

This section exists because the marketing around open-weight models consistently understates what it takes to run them well.

### The Three VRAM Tiers

Open-weight coding models in 2026 fall into bands defined by memory footprint, and the band determines whether self-hosting is realistic:

| Tier | VRAM | Representative models | License | Practical hardware |
|---|---|---|---|---|
| Frontier | 270-400 GB | DeepSeek V4-Pro, GLM-5.2, Kimi K2.6 | MIT | 4-8x H100/H200, or 512 GB unified memory |
| Workstation | 48-130 GB | Qwen3-Coder-Next 80B-A3B, Devstral-2 123B, MiniMax M3 | Apache 2.0 / MIT | 2x A100 80GB, 1x H100 at FP8 |
| Local | 8-32 GB | Qwen3-Coder 7B/14B, smaller distills | Apache 2.0 | Single L4, L40S, or consumer GPU |

The frontier tier is where the benchmark headlines come from and where most organizations discover the plan does not survive contact with a capacity request. GLM-5.2 advertises a 1M-token context window, which sounds ideal for agentic work until the KV cache for that context is sized. These models are, for the majority of enterprises, API models that happen to have downloadable weights.

The workstation tier is where self-hosted coding agents become genuinely usable. **Qwen3-Coder-Next** at 80B total parameters with 3B active is the architecture that makes this work: mixture-of-experts keeps the compute cost near a 3B dense model while the full parameter count delivers materially better code generation. Apache 2.0 licensing removes the commercial ambiguity entirely.

The Qwen family's suitability for self-hosting is not new; earlier generations established the pattern, as covered in [the Qwen Coder models guide](/qwen-coder-models-guide/). What changed is that the mixture-of-experts architecture moved the quality bar high enough for agentic work rather than autocomplete.

The local tier serves a real purpose that is frequently dismissed. Agent loops spend a surprising fraction of their turns on mechanical work: summarizing a file, generating a commit message, deciding which of six files to read next. Routing that traffic to a 7B model on an L40S rather than a frontier model is the single largest cost lever available.

### Break-Even Math

The following uses conservative on-demand cloud pricing and deliberately favors the self-hosted case by excluding platform engineering time.

```bash
# Self-hosted: one 8x H100 node running two workstation-tier models
# plus a small model for bulk traffic, at typical on-demand rates.
#
#   Node:            8x H100 80GB
#   On-demand rate:  ~$28.00/hour
#   Hours/month:     730 (continuous, no scale-to-zero)
#
#   Monthly compute: 28.00 * 730 = $20,440

# Per-seat SaaS baseline for comparison:
#
#   Mid-tier agent subscription: ~$100/developer/month
#
#   Break-even seat count: 20440 / 100 = 205 developers
```

Two hundred developers is the honest threshold, and it is optimistic. It assumes continuous utilization, ignores the storage and networking overhead, and excludes the engineering cost of operating the platform. Scale-to-zero on off-hours improves the picture; so does on-premises capex amortized over three years, where the same node lands closer to $7,000/month equivalent and drops break-even to roughly 70 seats.

The conclusion worth internalizing: **self-hosting coding agents is a compliance and control decision that becomes cost-neutral at scale, not a cost-reduction project.** Organizations that pitch it as savings under 100 developers will be disappointed.

## Serving the Model: vLLM on Kubernetes for Agent Workloads

vLLM is the default inference engine for this workload. Its OpenAI-compatible server, PagedAttention KV cache management, and continuous batching are covered thoroughly in [the vLLM production deployment guide](/vllm-production-deployment-kubernetes-llm-serving-enterprise-guide/). This section focuses on the configuration decisions that are specific to serving *agents* rather than chat traffic, because the defaults are wrong for agentic loops in three specific ways.

### Why Agent Traffic Is Different

A chat request is short, self-contained, and produces a short answer. An agent request is the opposite:

- **The prompt is enormous and highly repetitive.** Every turn resends the system prompt, the instruction files, the tool schemas, and the accumulated conversation. Prefix cache hit rates for agent workloads routinely exceed 80%, compared to near-zero for unrelated chat requests.
- **Tool calls are mandatory, not optional.** An agent that cannot emit a well-formed tool call is completely non-functional. Chat degrades gracefully; agents do not.
- **Context grows monotonically until compaction.** Sizing `--max-model-len` for the average request guarantees mid-session failures.

### The Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vllm-qwen3-coder
  namespace: ai-platform
  labels:
    app: vllm
    model: qwen3-coder-next
spec:
  replicas: 2
  selector:
    matchLabels:
      app: vllm
      model: qwen3-coder-next
  template:
    metadata:
      labels:
        app: vllm
        model: qwen3-coder-next
    spec:
      nodeSelector:
        node.kubernetes.io/instance-type: p4de.24xlarge
      containers:
        - name: vllm
          image: vllm/vllm-openai:v0.11.2
          args:
            - "--model"
            - "Qwen/Qwen3-Coder-Next-80B-A3B"
            # served-model-name is the identifier clients send. Decoupling it
            # from the HuggingFace path means swapping weights does not require
            # reconfiguring every developer workstation.
            - "--served-model-name"
            - "qwen3-coder"
            # Tool calling is non-negotiable for agents. The parser must match
            # the model family or every tool call arrives as unparsed text.
            - "--enable-auto-tool-choice"
            - "--tool-call-parser"
            - "hermes"
            # Sized for full agent sessions before compaction, not average turns.
            - "--max-model-len"
            - "131072"
            # Prefix caching is the highest-value flag for agent traffic.
            - "--enable-prefix-caching"
            - "--enable-chunked-prefill"
            - "--tensor-parallel-size"
            - "2"
            # Leave headroom. KV cache for 128k contexts is substantial and
            # OOM under load is far more disruptive than slightly lower throughput.
            - "--gpu-memory-utilization"
            - "0.88"
          ports:
            - containerPort: 8000
              name: http
          resources:
            limits:
              cpu: "10"
              memory: 40G
              nvidia.com/gpu: "2"
            requests:
              cpu: "4"
              memory: 20G
              nvidia.com/gpu: "2"
          volumeMounts:
            - name: model-cache
              mountPath: /root/.cache/huggingface
            # vLLM requires host shared memory for tensor-parallel inference.
            - name: shm
              mountPath: /dev/shm
          livenessProbe:
            httpGet:
              path: /health
              port: 8000
            initialDelaySeconds: 300
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /health
              port: 8000
            initialDelaySeconds: 300
            periodSeconds: 5
      volumes:
        - name: model-cache
          persistentVolumeClaim:
            claimName: vllm-model-cache
        - name: shm
          emptyDir:
            medium: Memory
            sizeLimit: 8Gi
```

The `initialDelaySeconds: 300` is deliberate and frequently gets tuned down by someone who has not watched an 80B model load. Weight loading from a cold PVC takes minutes; an aggressive liveness probe produces a CrashLoopBackOff that looks like a model problem and is actually a probe problem.

### Backing Storage and Service

The model cache should be `ReadWriteMany` so replicas share one copy of the weights rather than each pulling its own. On a rolling upgrade, both the outgoing and incoming model versions occupy the volume simultaneously, which is why the request below is roughly double a single model's footprint.

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: vllm-model-cache
  namespace: ai-platform
spec:
  accessModes:
    - ReadWriteMany
  resources:
    requests:
      # An 80B model at BF16 is roughly 160GB on disk. Sizing at 300Gi
      # allows holding two model versions during a rolling upgrade.
      storage: 300Gi
  storageClassName: longhorn
```

```yaml
apiVersion: v1
kind: Service
metadata:
  name: vllm-qwen3-coder
  namespace: ai-platform
spec:
  type: ClusterIP
  selector:
    app: vllm
    model: qwen3-coder-next
  ports:
    - name: http
      port: 80
      targetPort: 8000
```

### Verifying Tool Calling Before Anything Else

The single most common failure in this stack is a model that serves chat correctly and cannot emit tool calls. Test this before configuring a single agent:

```bash
# Port-forward the vLLM service and confirm the tool-calling path works.
kubectl -n ai-platform port-forward svc/vllm-qwen3-coder 8000:80 &

curl -s http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3-coder",
    "messages": [
      {"role": "user", "content": "List the files in the current directory."}
    ],
    "tools": [{
      "type": "function",
      "function": {
        "name": "run_bash",
        "description": "Execute a bash command",
        "parameters": {
          "type": "object",
          "properties": {
            "command": {"type": "string"}
          },
          "required": ["command"]
        }
      }
    }],
    "tool_choice": "auto"
  }' | jq '.choices[0].message'

# A working deployment returns a populated tool_calls array.
# If the command appears inside "content" as prose instead, the
# --tool-call-parser value does not match the model family.
```

## Path A: Direct Connection

For a single team running a single model, the gateway is unnecessary overhead. Any agent speaking the OpenAI protocol connects straight to the vLLM Service.

Expose it through an Ingress with TLS:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: vllm-qwen3-coder
  namespace: ai-platform
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/proxy-read-timeout: "600"
    nginx.ingress.kubernetes.io/proxy-body-size: "32m"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - inference.support.tools
      secretName: inference-tls
  rules:
    - host: inference.support.tools
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: vllm-qwen3-coder
                port:
                  number: 80
```

The `proxy-read-timeout: "600"` matters. Agent requests with large contexts and extended reasoning can exceed the 60-second nginx default, and the resulting truncation surfaces as a mid-stream connection reset that agents report as an opaque network error.

The limits of this path appear quickly. There is no per-user attribution, no spend tracking, no way to route different workloads to different models, and no support for any client that does not speak the OpenAI protocol. That last constraint eliminates Claude Code entirely.

## Path B: The LiteLLM Gateway

**LiteLLM** is an open-source AI gateway that presents a unified interface across providers and, critically for this architecture, translates between protocol dialects. It accepts requests on `/v1/messages` in the Anthropic format and forwards them to OpenAI-format upstreams, which is precisely what makes Claude Code work against vLLM.

### Gateway Configuration

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: litellm-config
  namespace: ai-platform
data:
  config.yaml: |
    model_list:
      # Reasoning tier - routed for planning and complex edits.
      - model_name: coder-reasoning
        litellm_params:
          model: hosted_vllm/qwen3-coder
          api_base: http://vllm-qwen3-coder.ai-platform.svc.cluster.local
          api_key: os.environ/VLLM_API_KEY

      # Bulk tier - summarization, commit messages, file triage.
      - model_name: coder-fast
        litellm_params:
          model: hosted_vllm/qwen3-coder-7b
          api_base: http://vllm-qwen3-small.ai-platform.svc.cluster.local
          api_key: os.environ/VLLM_API_KEY

      # Alias consumed by Claude Code, which requires Anthropic-style names.
      - model_name: claude-sonnet-4-5
        litellm_params:
          model: hosted_vllm/qwen3-coder
          api_base: http://vllm-qwen3-coder.ai-platform.svc.cluster.local
          api_key: os.environ/VLLM_API_KEY

    litellm_settings:
      drop_params: true
      num_retries: 2
      request_timeout: 600
      success_callback: ["prometheus"]
      failure_callback: ["prometheus"]

    general_settings:
      master_key: os.environ/LITELLM_MASTER_KEY
      database_url: os.environ/DATABASE_URL
      store_model_in_db: true
```

The `drop_params: true` setting deserves specific attention. Agents routinely send parameters that a given backend does not implement, and without this flag LiteLLM returns a 400 that the agent surfaces as a hard failure. Dropping unsupported parameters converts a fatal error into a silent degradation, which is the correct tradeoff for this workload.

The `claude-sonnet-4-5` alias is not cosmetic. Claude Code validates model identifiers against expected naming patterns, and pointing it at a model called `qwen3-coder` produces confusing client-side errors. Aliasing at the gateway keeps the client happy while the actual inference runs on open weights.

### Deploying the Gateway

The gateway is stateless apart from its database connection, so it scales horizontally without coordination. Three replicas is a reasonable starting point: the workload is I/O-bound proxying rather than computation, and the resource footprint is negligible next to the GPU nodes behind it. The database backing `store_model_in_db` holds virtual keys and spend records, so it must be durable — losing it invalidates every developer credential at once.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: litellm
  namespace: ai-platform
spec:
  replicas: 3
  selector:
    matchLabels:
      app: litellm
  template:
    metadata:
      labels:
        app: litellm
    spec:
      containers:
        - name: litellm
          image: ghcr.io/berriai/litellm:main-v1.79.3
          args: ["--config", "/app/config/config.yaml", "--port", "4000"]
          ports:
            - containerPort: 4000
              name: http
          env:
            - name: LITELLM_MASTER_KEY
              valueFrom:
                secretKeyRef:
                  name: litellm-secrets
                  key: master-key
            - name: VLLM_API_KEY
              valueFrom:
                secretKeyRef:
                  name: litellm-secrets
                  key: vllm-api-key
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: litellm-secrets
                  key: database-url
          resources:
            limits:
              cpu: "2"
              memory: 4Gi
            requests:
              cpu: "500m"
              memory: 1Gi
          volumeMounts:
            - name: config
              mountPath: /app/config
          readinessProbe:
            httpGet:
              path: /health/readiness
              port: 4000
            initialDelaySeconds: 20
            periodSeconds: 5
      volumes:
        - name: config
          configMap:
            name: litellm-config
```

### Issuing Per-Developer Virtual Keys

Virtual keys are the mechanism that turns a shared endpoint into an auditable one. Each developer receives a distinct key, scoped to specific models with an optional budget:

```bash
# Mint a scoped key for an individual developer.
# The master key is admin-only and must never reach a workstation.
curl -s -X POST https://llm-gateway.support.tools/key/generate \
  -H "Authorization: Bearer ${LITELLM_MASTER_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "models": ["coder-reasoning", "coder-fast", "claude-sonnet-4-5"],
    "max_budget": 200,
    "budget_duration": "30d",
    "user_id": "mmattox@support.tools",
    "team_id": "platform-engineering",
    "metadata": {"purpose": "coding-agent"}
  }' | jq -r '.key'

# Per-team spend is then queryable without vendor dashboards.
curl -s https://llm-gateway.support.tools/spend/tags \
  -H "Authorization: Bearer ${LITELLM_MASTER_KEY}" | jq
```

## Configuring Pi

**Pi** is an MIT-licensed terminal coding agent from earendil-works. It is the cleanest fit for this architecture because custom providers are a first-class configuration concern rather than an environment-variable workaround, and because it natively speaks multiple API dialects instead of assuming one vendor.

### Installation

Pi ships as an npm package with a deliberately small core. Capability that other agents bundle by default — web search, image analysis, browser control — arrives as separately installed packages, which keeps the base context footprint low and makes the installed surface auditable.

```bash
# Install the coding agent globally.
pnpm add -g @earendil-works/pi-coding-agent

# Optional capability packages, installed into the agent rather than the core.
pi install npm:pi-agent-web-access

# Verify the binary resolves before configuring providers.
pi --version
```

### Provider Configuration

Pi reads provider definitions from `~/.pi/agent/models.json`. The file is reloaded every time `/model` is invoked, so changes take effect without restarting a session:

```json
{
  "providers": {
    "internal": {
      "baseUrl": "https://llm-gateway.support.tools/v1",
      "api": "openai-completions",
      "apiKey": "$LITELLM_VIRTUAL_KEY",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        {
          "id": "coder-reasoning",
          "name": "Qwen3 Coder (reasoning)",
          "contextWindow": 131072,
          "maxTokens": 32768,
          "reasoning": true,
          "input": ["text"]
        },
        {
          "id": "coder-fast",
          "name": "Qwen3 Coder 7B (bulk)",
          "contextWindow": 32768,
          "maxTokens": 8192,
          "reasoning": false,
          "input": ["text"]
        }
      ]
    }
  }
}
```

Three fields carry more weight than their size suggests.

**`api`** selects the wire protocol. `openai-completions` covers vLLM, Ollama, SGLang, and effectively every OpenAI-compatible server. Pi also supports `anthropic-messages`, `openai-responses`, `azure-openai-responses`, `mistral-conversations`, `google-generative-ai`, `google-vertex`, and `bedrock-converse-stream`, which means a single agent can address a self-hosted endpoint and a cloud provider side by side.

**`compat`** encodes the ways a self-hosted server diverges from the OpenAI specification. Both flags shown above are documented specifically for Ollama, vLLM, and SGLang. `supportsDeveloperRole: false` prevents Pi from emitting the `developer` role that vLLM rejects; `supportsReasoningEffort: false` suppresses a parameter that produces a 400 on backends that never implemented it.

**`contextWindow`** defaults to 128000 when omitted, which is a trap. If vLLM is serving with a lower `--max-model-len` than the value Pi believes it has, sessions fail partway through with a truncation error rather than a clean rejection. These two numbers must agree.

### Credential Handling Without Plaintext Keys

The `apiKey` field resolves three ways: a literal string, an environment variable via `$VAR` or `${PREFIX}_${SUFFIX}`, or a shell command via the `!` prefix. The third form is the one that matters for enterprise deployments, because it retrieves the credential at call time instead of persisting it in a dotfile:

```json
{
  "providers": {
    "internal": {
      "baseUrl": "https://llm-gateway.support.tools/v1",
      "api": "openai-completions",
      "apiKey": "!vault kv get -field=key secret/ai-platform/litellm-dev",
      "models": [{ "id": "coder-reasoning" }]
    }
  }
}
```

This composes with short-lived Vault tokens and leaves no long-lived secret on the workstation. Literal `$` and `!` characters are escaped as `$$` and `$!` respectively.

### Registering Providers From an Extension

For deployments requiring OAuth, SSO, or injected headers, the extension API offers programmatic registration:

```typescript
// ~/.pi/agent/extensions/internal-provider.ts
//
// registerProvider with a models array defines a new provider.
// Called with only baseUrl or headers, it overrides an existing one --
// useful for transparently redirecting a vendor provider to an
// internal proxy without touching per-model configuration.
pi.registerProvider("internal", {
  baseUrl: "https://llm-gateway.support.tools/v1",
  apiKey: "$LITELLM_VIRTUAL_KEY",
  api: "openai-completions",
  headers: {
    "x-team-id": "platform-engineering",
  },
  models: [
    {
      id: "coder-reasoning",
      name: "Qwen3 Coder (reasoning)",
      contextWindow: 131072,
      maxTokens: 32768,
    },
  ],
});

// Rewriting overflow errors into the shape pi recognizes lets the
// harness trigger automatic compaction instead of failing the session.
pi.on("message_end", (event) => {
  if (event.error?.message?.includes("maximum context length")) {
    event.error.type = "context_length_exceeded";
  }
});
```

That last hook addresses a real operational problem. Pi triggers automatic compaction when it recognizes a context-overflow error, but self-hosted backends phrase the error differently than the providers Pi was built against. Without normalization, an overflow kills the session instead of compacting it.

## Configuring Claude Code

Claude Code speaks only the Anthropic Messages API. It cannot address a vLLM endpoint directly, which makes the gateway mandatory rather than optional on this path.

Configuration is entirely environment-driven and belongs in the settings file so it applies to every session:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://llm-gateway.support.tools",
    "ANTHROPIC_AUTH_TOKEN": "sk-litellm-Kd8vN2xQmR4tZpL9",
    "ANTHROPIC_MODEL": "claude-sonnet-4-5",
    "ANTHROPIC_SMALL_FAST_MODEL": "coder-fast"
  }
}
```

Written to `~/.claude/settings.json`, this routes every Claude Code session through the internal gateway.

The distinction between `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` causes recurring confusion. `ANTHROPIC_AUTH_TOKEN` sets the literal bearer token in the `Authorization` header, which is what a gateway issuing its own virtual keys requires. Using `ANTHROPIC_API_KEY` against a gateway produces authentication failures that appear to be gateway misconfiguration.

`ANTHROPIC_SMALL_FAST_MODEL` is the highest-leverage setting in the block. Claude Code delegates background work — conversation summarization, title generation, file triage — to this model. Pointing it at the bulk tier removes a substantial fraction of traffic from the expensive GPUs.

Verify the routing before assuming it works:

```bash
# Confirm the gateway is reachable and the Anthropic-format path resolves.
curl -s https://llm-gateway.support.tools/v1/messages \
  -H "Authorization: Bearer ${ANTHROPIC_AUTH_TOKEN}" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 64,
    "messages": [{"role": "user", "content": "Reply with the word ready."}]
  }' | jq '.content[0].text'
```

## Configuring Cline and Aider

Both tools take the OpenAI-compatible path and require no protocol translation.

**Cline** runs as a VS Code extension and is configured through its settings UI or the workspace settings file:

```json
{
  "cline.apiProvider": "openai",
  "cline.openAiBaseUrl": "https://llm-gateway.support.tools/v1",
  "cline.openAiModelId": "coder-reasoning",
  "cline.openAiApiKey": "sk-litellm-Kd8vN2xQmR4tZpL9"
}
```

**Aider** accepts the endpoint on the command line or through environment variables:

```bash
# Environment-driven configuration, suitable for a shell profile.
export OPENAI_API_BASE="https://llm-gateway.support.tools/v1"
export OPENAI_API_KEY="sk-litellm-Kd8vN2xQmR4tZpL9"

# The openai/ prefix tells aider to use the OpenAI-compatible client
# rather than attempting provider auto-detection.
aider --model openai/coder-reasoning \
      --weak-model openai/coder-fast \
      --no-auto-commits
```

The `--weak-model` flag mirrors Claude Code's small-fast-model concept, routing commit message generation and repository map summarization to the bulk tier.

## Instruction File Portability

Every agent reads project instructions from a different filename, and organizations running more than one agent end up maintaining divergent copies that drift within weeks.

| Agent | Instruction file | Scope |
|---|---|---|
| Pi | `AGENTS.md` | Project context |
| Pi | `APPEND_SYSTEM.md` | Appended behavioral rules |
| Claude Code | `CLAUDE.md` | Project and user-global |
| Cline | `.clinerules` | Project |
| Aider | `CONVENTIONS.md` | Passed via `--read` |

The practical resolution is to designate one file as canonical and symlink the rest:

```bash
# AGENTS.md is the emerging cross-agent convention. Treat it as the
# source of truth and link the agent-specific names to it.
cd /home/mmattox/go/src/github.com/supporttools/website

ln -sf AGENTS.md CLAUDE.md
ln -sf AGENTS.md .clinerules
ln -sf AGENTS.md CONVENTIONS.md

# Commit the symlinks so every clone inherits the same wiring.
git add AGENTS.md CLAUDE.md .clinerules CONVENTIONS.md
git commit -m "Consolidate agent instructions on AGENTS.md"
```

One caveat applies specifically to Claude Code: instruction files are injected as context, not as system prompt, and lose to the built-in system prompt on tone conflicts. That behavior and its workarounds are covered in detail in [the Claude Code system prompt analysis](/claude-code-system-prompt-behavior-claude-md-optimization-guide/). Pi's `APPEND_SYSTEM.md` occupies a genuinely different position in the hierarchy, appending to the system prompt rather than the context window, which makes behavioral rules meaningfully stickier.

## Failure Modes

Five failure patterns account for the overwhelming majority of incidents in this stack.

### Tool Calls Arriving as Prose

**Symptom:** The agent narrates what it intends to do but never executes anything. Tool calls appear in the message content as text.

**Cause:** `--tool-call-parser` does not match the model family. The parser is responsible for extracting structured calls from model output, and a mismatch produces valid-looking prose.

**Resolution:** Match the parser to the model. Verify with the curl test from the serving section before investigating the client.

```bash
# Inspect what the model actually emitted at the wire level.
kubectl -n ai-platform logs deploy/vllm-qwen3-coder --tail=200 \
  | grep -iE "tool_call|parser|hermes"
```

### Context Window Disagreement

**Symptom:** Sessions run normally and then fail abruptly partway through, often after a large file read.

**Cause:** The client's declared `contextWindow` exceeds the server's `--max-model-len`. The client keeps appending under the belief it has room, and the server rejects the request once the true limit is crossed.

**Resolution:** Query the server for its actual limit and make the client agree.

```bash
# The served context length is authoritative. Client config must not exceed it.
kubectl -n ai-platform exec deploy/vllm-qwen3-coder -- \
  curl -s http://localhost:8000/v1/models | jq '.data[0].max_model_len'
```

### Silent OpenAI Specification Divergence

**Symptom:** Intermittent 400 responses on some requests, typically correlated with reasoning-heavy turns.

**Cause:** The agent emits a parameter the backend never implemented — `reasoning_effort` and the `developer` role are the usual offenders.

**Resolution:** Set the corresponding `compat` flags in Pi, or enable `drop_params: true` at the gateway to strip unsupported parameters centrally. The gateway approach is preferable because it fixes every client at once.

### Streaming Truncation Under Load

**Symptom:** Long generations cut off mid-token. Agents report opaque network errors rather than anything diagnostic.

**Cause:** An ingress or gateway timeout shorter than the generation time. The nginx 60-second default is the common culprit.

**Resolution:** Raise `proxy-read-timeout` on the Ingress and `request_timeout` in the LiteLLM settings. Both must exceed the longest expected generation.

### Cold Start CrashLoopBackOff

**Symptom:** Pods restart repeatedly after a node drain or rollout, never reaching Ready.

**Cause:** Liveness probe `initialDelaySeconds` shorter than the model load time. An 80B model loading from a cold PVC can exceed five minutes.

**Resolution:** Set `initialDelaySeconds` above the observed worst-case load time and confirm the PVC uses a storage class with adequate read throughput.

```bash
# Measure actual load time before tuning probes downward.
kubectl -n ai-platform logs deploy/vllm-qwen3-coder \
  | grep -iE "loading weights|model loading took|init engine"
```

## Agent Comparison Matrix

| Capability | Pi | Claude Code | Cline | Aider |
|---|---|---|---|---|
| Self-host mechanism | `models.json` / `registerProvider()` | Environment variables | Settings UI | CLI flags / env |
| Native protocols | 8 dialects | Anthropic Messages only | OpenAI-compatible | OpenAI-compatible |
| Gateway required | No | Yes | No | No |
| License | MIT | Proprietary | Apache 2.0 | Apache 2.0 |
| Interface | Terminal | Terminal | VS Code | Terminal |
| Extension system | Packages + TypeScript API | Hooks, MCP, skills | MCP | None |
| Secret-store auth | Yes, via `!command` | Environment only | Settings file | Environment only |
| Compatibility flags | Yes, `compat` block | No | No | No |
| Multi-model routing | Per-session switch | Main + small-fast | Single model | Main + weak |

Selection guidance follows the constraints rather than preference:

- **Pi** where protocol flexibility and credential hygiene matter most. The `compat` block and `!command` credential resolution are unmatched among the alternatives, and the multi-dialect support means one tool addresses both internal and vendor endpoints.
- **Claude Code** where teams are already invested and the gateway is acceptable infrastructure. The hook and skill ecosystem is the most mature of the four.
- **Cline** where developers want agent capability without leaving the editor.
- **Aider** where scripted and non-interactive use dominates. Its git integration remains the strongest.

## Conclusion

Running coding agents against internal inference is a solved infrastructure problem in 2026. The remaining work is operational discipline rather than missing capability.

- **The agent layer is portable; the model layer is the lock-in.** Every major agent CLI accepts a custom endpoint. Protocol dialect, not vendor relationship, determines what connects to what.
- **A gateway becomes mandatory the moment clients disagree on protocol.** LiteLLM's Anthropic-to-OpenAI translation is the specific capability that brings Claude Code into a self-hosted architecture.
- **Self-hosting is a control decision, not a savings plan.** Break-even sits near 200 developers at on-demand cloud pricing and roughly 70 with amortized on-premises hardware. Organizations pitching it as cost reduction below that threshold will not deliver.
- **The workstation tier is where self-hosted coding becomes real.** Qwen3-Coder-Next at 80B-A3B under Apache 2.0 runs on hardware enterprises already own. Frontier open-weight models remain effectively API models without 80 GB-class multi-GPU capacity.
- **Agent traffic is not chat traffic.** Prefix caching, generous context sizing, and correct tool-call parser selection matter far more than the throughput tuning that dominates general inference guidance.
- **Route bulk work to small models.** Summarization, commit messages, and file triage consume a large share of agent turns and belong nowhere near the expensive GPUs.
- **Consolidate instruction files early.** Symlinking `CLAUDE.md`, `.clinerules`, and `CONVENTIONS.md` to a canonical `AGENTS.md` prevents the drift that appears within weeks of running more than one agent.
- **Verify tool calling before anything else.** A backend that serves chat correctly and cannot emit structured tool calls will fail every agent connected to it, and the resulting errors point everywhere except the actual cause.
