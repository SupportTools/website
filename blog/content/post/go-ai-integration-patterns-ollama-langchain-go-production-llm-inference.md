---
title: "Go AI Integration Patterns: Ollama, LangChain-Go, and Production LLM Inference"
date: 2030-01-03T00:00:00-05:00
draft: false
tags: ["Go", "AI", "LLM", "Ollama", "LangChain-Go", "RAG", "Inference", "OpenAI", "Production", "Machine Learning"]
categories:
- Go
- AI
- Machine Learning
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Ollama API client, LangChain-Go chains, RAG implementation, streaming responses, token counting, and LLM observability for production Go services."
more_link: "yes"
url: "/go-ai-integration-patterns-ollama-langchain-go-production-llm-inference/"
---

Integrating large language models into production Go services requires the same engineering discipline applied to any external dependency: connection pooling, retry logic, streaming for responsiveness, cost control through token counting, and observability. This guide covers the complete Go LLM integration stack from local Ollama development through production-grade RAG implementations.

<!--more-->

## Section 1: Ollama — Local LLM Development

Ollama runs LLMs locally, providing an OpenAI-compatible REST API. It is the standard starting point for Go LLM development because it enables local testing without API keys or network dependencies.

### Installing and Running Ollama

```bash
# Install Ollama.
curl -fsSL https://ollama.com/install.sh | sh

# Pull a model for development.
ollama pull llama3.2:3b          # Small model for fast local testing.
ollama pull codellama:7b          # Code-focused model.
ollama pull nomic-embed-text:v1.5  # Embedding model for RAG.

# Start the Ollama server (runs on :11434 by default).
ollama serve &

# Verify the API is available.
curl http://localhost:11434/api/tags | jq '.models[].name'
```

### Direct Ollama API Client in Go

```go
package ollama

import (
    "bufio"
    "bytes"
    "context"
    "encoding/json"
    "fmt"
    "io"
    "net/http"
    "time"
)

// Client is an Ollama API client.
type Client struct {
    baseURL    string
    httpClient *http.Client
}

// NewClient creates a new Ollama client.
func NewClient(baseURL string) *Client {
    if baseURL == "" {
        baseURL = "http://localhost:11434"
    }
    return &Client{
        baseURL: baseURL,
        httpClient: &http.Client{
            Timeout: 5 * time.Minute, // LLM responses can be slow.
        },
    }
}

// GenerateRequest is the request body for the generate API.
type GenerateRequest struct {
    Model   string                 `json:"model"`
    Prompt  string                 `json:"prompt"`
    System  string                 `json:"system,omitempty"`
    Stream  bool                   `json:"stream"`
    Options map[string]interface{} `json:"options,omitempty"`
}

// GenerateResponse is a streaming chunk from the generate API.
type GenerateResponse struct {
    Model     string `json:"model"`
    Response  string `json:"response"`
    Done      bool   `json:"done"`
    TotalDuration int64 `json:"total_duration,omitempty"`
    EvalCount     int   `json:"eval_count,omitempty"`
}

// GenerateStream calls the Ollama generate API and streams tokens to the output channel.
func (c *Client) GenerateStream(ctx context.Context, req GenerateRequest) (<-chan GenerateResponse, error) {
    req.Stream = true
    body, err := json.Marshal(req)
    if err != nil {
        return nil, fmt.Errorf("marshal request: %w", err)
    }

    httpReq, err := http.NewRequestWithContext(ctx,
        http.MethodPost, c.baseURL+"/api/generate", bytes.NewReader(body))
    if err != nil {
        return nil, fmt.Errorf("create request: %w", err)
    }
    httpReq.Header.Set("Content-Type", "application/json")

    resp, err := c.httpClient.Do(httpReq)
    if err != nil {
        return nil, fmt.Errorf("http request: %w", err)
    }
    if resp.StatusCode != http.StatusOK {
        resp.Body.Close()
        return nil, fmt.Errorf("ollama returned %d", resp.StatusCode)
    }

    ch := make(chan GenerateResponse, 100)
    go func() {
        defer close(ch)
        defer resp.Body.Close()

        scanner := bufio.NewScanner(resp.Body)
        for scanner.Scan() {
            var chunk GenerateResponse
            if err := json.Unmarshal(scanner.Bytes(), &chunk); err != nil {
                continue
            }
            select {
            case ch <- chunk:
            case <-ctx.Done():
                return
            }
            if chunk.Done {
                return
            }
        }
    }()

    return ch, nil
}

// Generate calls the Ollama generate API and returns the complete response.
func (c *Client) Generate(ctx context.Context, req GenerateRequest) (string, error) {
    req.Stream = false
    body, err := json.Marshal(req)
    if err != nil {
        return "", err
    }

    httpReq, err := http.NewRequestWithContext(ctx,
        http.MethodPost, c.baseURL+"/api/generate", bytes.NewReader(body))
    if err != nil {
        return "", err
    }
    httpReq.Header.Set("Content-Type", "application/json")

    resp, err := c.httpClient.Do(httpReq)
    if err != nil {
        return "", err
    }
    defer resp.Body.Close()

    data, err := io.ReadAll(resp.Body)
    if err != nil {
        return "", err
    }

    var result GenerateResponse
    if err := json.Unmarshal(data, &result); err != nil {
        return "", err
    }
    return result.Response, nil
}
```

### Embedding API for RAG

```go
// EmbedRequest is the request body for the embedding API.
type EmbedRequest struct {
    Model  string `json:"model"`
    Input  string `json:"input"`
}

// EmbedResponse contains the embedding vector.
type EmbedResponse struct {
    Model      string      `json:"model"`
    Embeddings [][]float32 `json:"embeddings"`
}

// Embed generates an embedding vector for the given text.
func (c *Client) Embed(ctx context.Context, model, text string) ([]float32, error) {
    req := EmbedRequest{Model: model, Input: text}
    body, _ := json.Marshal(req)

    httpReq, _ := http.NewRequestWithContext(ctx,
        http.MethodPost, c.baseURL+"/api/embed", bytes.NewReader(body))
    httpReq.Header.Set("Content-Type", "application/json")

    resp, err := c.httpClient.Do(httpReq)
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()

    var result EmbedResponse
    json.NewDecoder(resp.Body).Decode(&result)

    if len(result.Embeddings) == 0 {
        return nil, fmt.Errorf("no embeddings returned")
    }
    return result.Embeddings[0], nil
}
```

## Section 2: OpenAI-Compatible Client for Multiple Backends

Using an OpenAI-compatible client allows switching between Ollama (local), OpenAI, Anthropic's API, and other providers without code changes:

```bash
go get github.com/sashabaranov/go-openai@v1.36.0
```

```go
package llmclient

import (
    "context"
    "fmt"
    "io"

    openai "github.com/sashabaranov/go-openai"
)

// LLMConfig holds configuration for an LLM backend.
type LLMConfig struct {
    BaseURL string
    APIKey  string
    Model   string
}

// Client wraps the OpenAI-compatible API.
type Client struct {
    oa  *openai.Client
    cfg LLMConfig
}

// NewOllamaClient creates a client pointing at a local Ollama instance.
func NewOllamaClient(model string) *Client {
    cfg := openai.DefaultConfig("ollama") // Ollama ignores the API key.
    cfg.BaseURL = "http://localhost:11434/v1"
    return &Client{
        oa:  openai.NewClientWithConfig(cfg),
        cfg: LLMConfig{BaseURL: "http://localhost:11434/v1", Model: model},
    }
}

// NewOpenAIClient creates a client for OpenAI's API.
func NewOpenAIClient(apiKey, model string) *Client {
    return &Client{
        oa:  openai.NewClient(apiKey),
        cfg: LLMConfig{APIKey: apiKey, Model: model},
    }
}

// ChatMessage represents a conversation message.
type ChatMessage struct {
    Role    string
    Content string
}

// Complete sends a chat completion request and returns the response text.
func (c *Client) Complete(ctx context.Context, messages []ChatMessage) (string, error) {
    oaMessages := make([]openai.ChatCompletionMessage, len(messages))
    for i, m := range messages {
        oaMessages[i] = openai.ChatCompletionMessage{Role: m.Role, Content: m.Content}
    }

    resp, err := c.oa.CreateChatCompletion(ctx, openai.ChatCompletionRequest{
        Model:    c.cfg.Model,
        Messages: oaMessages,
    })
    if err != nil {
        return "", fmt.Errorf("chat completion: %w", err)
    }
    if len(resp.Choices) == 0 {
        return "", fmt.Errorf("no choices returned")
    }
    return resp.Choices[0].Message.Content, nil
}

// StreamComplete streams the response tokens to the provided writer.
func (c *Client) StreamComplete(ctx context.Context, messages []ChatMessage, w io.Writer) error {
    oaMessages := make([]openai.ChatCompletionMessage, len(messages))
    for i, m := range messages {
        oaMessages[i] = openai.ChatCompletionMessage{Role: m.Role, Content: m.Content}
    }

    stream, err := c.oa.CreateChatCompletionStream(ctx, openai.ChatCompletionRequest{
        Model:    c.cfg.Model,
        Messages: oaMessages,
        Stream:   true,
    })
    if err != nil {
        return fmt.Errorf("create stream: %w", err)
    }
    defer stream.Close()

    for {
        resp, err := stream.Recv()
        if err == io.EOF {
            return nil
        }
        if err != nil {
            return fmt.Errorf("stream recv: %w", err)
        }
        if len(resp.Choices) > 0 {
            fmt.Fprint(w, resp.Choices[0].Delta.Content)
        }
    }
}
```

## Section 3: LangChain-Go for Chains and Agents

LangChain-Go provides higher-level abstractions for common LLM patterns including chains, agents, and retrieval:

```bash
go get github.com/tmc/langchaingo@v0.1.13
```

### Simple Chain

```go
package chains

import (
    "context"
    "fmt"

    "github.com/tmc/langchaingo/chains"
    "github.com/tmc/langchaingo/llms/ollama"
    "github.com/tmc/langchaingo/prompts"
)

func RunSummarizationChain(ctx context.Context, text string) (string, error) {
    llm, err := ollama.New(ollama.WithModel("llama3.2:3b"))
    if err != nil {
        return "", fmt.Errorf("create ollama llm: %w", err)
    }

    prompt := prompts.NewPromptTemplate(
        `Summarize the following text in 3 bullet points:

{{.text}}

Summary:`,
        []string{"text"},
    )

    chain := chains.NewLLMChain(llm, prompt)

    output, err := chains.Call(ctx, chain, map[string]any{
        "text": text,
    })
    if err != nil {
        return "", fmt.Errorf("chain call: %w", err)
    }

    return output["text"].(string), nil
}
```

### Sequential Chain (Multi-Step Processing)

```go
package chains

import (
    "context"

    "github.com/tmc/langchaingo/chains"
    "github.com/tmc/langchaingo/llms/ollama"
    "github.com/tmc/langchaingo/prompts"
)

func RunDocumentProcessingPipeline(ctx context.Context, document string) (string, error) {
    llm, err := ollama.New(ollama.WithModel("llama3.2:3b"))
    if err != nil {
        return "", err
    }

    // Step 1: Extract key entities.
    extractPrompt := prompts.NewPromptTemplate(
        "Extract the main entities (people, organizations, locations) from:\n\n{{.input}}\n\nEntities:",
        []string{"input"},
    )
    extractChain := chains.NewLLMChain(llm, extractPrompt)

    // Step 2: Generate a structured summary.
    summaryPrompt := prompts.NewPromptTemplate(
        "Given these entities:\n{{.entities}}\n\nGenerate a structured JSON summary:\n\n{{.input}}",
        []string{"input", "entities"},
    )
    summaryChain := chains.NewLLMChain(llm, summaryPrompt)

    // Run step 1.
    extractResult, err := chains.Call(ctx, extractChain, map[string]any{
        "input": document,
    })
    if err != nil {
        return "", err
    }

    // Run step 2 with the output of step 1.
    summaryResult, err := chains.Call(ctx, summaryChain, map[string]any{
        "input":    document,
        "entities": extractResult["text"],
    })
    if err != nil {
        return "", err
    }

    return summaryResult["text"].(string), nil
}
```

## Section 4: Retrieval-Augmented Generation (RAG)

RAG improves LLM accuracy on domain-specific questions by providing relevant context from a vector database.

### Setting Up a Vector Store

```bash
go get github.com/tmc/langchaingo@v0.1.13
# For pgvector backend.
go get github.com/pgvector/pgvector-go@v0.3.0
```

### Simple In-Memory Vector Store

```go
package rag

import (
    "context"
    "math"
    "sort"
)

// Document represents a text document with its embedding.
type Document struct {
    ID        string
    Content   string
    Embedding []float32
    Metadata  map[string]string
}

// VectorStore is a simple in-memory vector store.
type VectorStore struct {
    docs []Document
}

// Add stores a document and its embedding.
func (v *VectorStore) Add(doc Document) {
    v.docs = append(v.docs, doc)
}

// cosineSimilarity computes the cosine similarity between two vectors.
func cosineSimilarity(a, b []float32) float32 {
    var dotProduct, normA, normB float32
    for i := range a {
        dotProduct += a[i] * b[i]
        normA += a[i] * a[i]
        normB += b[i] * b[i]
    }
    if normA == 0 || normB == 0 {
        return 0
    }
    return dotProduct / float32(math.Sqrt(float64(normA))*math.Sqrt(float64(normB)))
}

// SimilarityResult holds a document and its similarity score.
type SimilarityResult struct {
    Document   Document
    Similarity float32
}

// Search finds the top-k most similar documents to the query embedding.
func (v *VectorStore) Search(queryEmbedding []float32, topK int) []SimilarityResult {
    results := make([]SimilarityResult, 0, len(v.docs))
    for _, doc := range v.docs {
        sim := cosineSimilarity(queryEmbedding, doc.Embedding)
        results = append(results, SimilarityResult{Document: doc, Similarity: sim})
    }
    sort.Slice(results, func(i, j int) bool {
        return results[i].Similarity > results[j].Similarity
    })
    if topK > len(results) {
        topK = len(results)
    }
    return results[:topK]
}
```

### Complete RAG Pipeline

```go
package rag

import (
    "context"
    "fmt"
    "strings"

    "github.com/example/myapp/ollama"
)

// RAGPipeline combines a vector store with an LLM for retrieval-augmented generation.
type RAGPipeline struct {
    vectorStore    *VectorStore
    ollamaClient   *ollama.Client
    embeddingModel string
    llmModel       string
}

// NewRAGPipeline creates a new RAG pipeline.
func NewRAGPipeline(embedModel, llmModel string) *RAGPipeline {
    return &RAGPipeline{
        vectorStore:    &VectorStore{},
        ollamaClient:   ollama.NewClient(""),
        embeddingModel: embedModel,
        llmModel:       llmModel,
    }
}

// IndexDocument adds a document to the knowledge base.
func (r *RAGPipeline) IndexDocument(ctx context.Context, id, content string, metadata map[string]string) error {
    embedding, err := r.ollamaClient.Embed(ctx, r.embeddingModel, content)
    if err != nil {
        return fmt.Errorf("embed document %s: %w", id, err)
    }
    r.vectorStore.Add(Document{
        ID:        id,
        Content:   content,
        Embedding: embedding,
        Metadata:  metadata,
    })
    return nil
}

// Answer retrieves relevant context and generates an answer using the LLM.
func (r *RAGPipeline) Answer(ctx context.Context, question string) (string, error) {
    // Embed the question.
    queryEmbedding, err := r.ollamaClient.Embed(ctx, r.embeddingModel, question)
    if err != nil {
        return "", fmt.Errorf("embed question: %w", err)
    }

    // Retrieve top-5 similar documents.
    results := r.vectorStore.Search(queryEmbedding, 5)

    // Build context from retrieved documents.
    var contextBuilder strings.Builder
    for i, result := range results {
        fmt.Fprintf(&contextBuilder, "Document %d (similarity: %.3f):\n%s\n\n",
            i+1, result.Similarity, result.Document.Content)
    }

    // Build the prompt.
    prompt := fmt.Sprintf(`You are a helpful assistant. Answer the question based on the provided context.
If the answer is not in the context, say "I don't have enough information to answer that."

Context:
%s

Question: %s

Answer:`, contextBuilder.String(), question)

    return r.ollamaClient.Generate(ctx, ollama.GenerateRequest{
        Model:  r.llmModel,
        Prompt: prompt,
        Options: map[string]interface{}{
            "temperature": 0.1, // Low temperature for factual responses.
            "top_p":       0.9,
        },
    })
}
```

## Section 5: Token Counting and Cost Control

```go
package tokens

import (
    "strings"
    "unicode"
)

// EstimateTokens provides a rough token count estimate.
// For precise counting, use tiktoken-go or the model's native tokenizer.
// Rule of thumb: ~1 token per 4 characters for English text.
func EstimateTokens(text string) int {
    words := strings.Fields(text)
    totalChars := 0
    for _, word := range words {
        totalChars += len(word)
    }
    // Average ~4 chars per token for English.
    return totalChars/4 + len(words)/5
}

// CostEstimate calculates the estimated API cost for a request.
type CostEstimate struct {
    InputTokens    int
    OutputTokens   int
    InputCostUSD   float64
    OutputCostUSD  float64
    TotalCostUSD   float64
}

// ModelPricing contains per-token pricing for common models.
var ModelPricing = map[string][2]float64{
    // [input_cost_per_1k_tokens, output_cost_per_1k_tokens]
    "gpt-4o":          {0.005, 0.015},
    "gpt-4o-mini":     {0.00015, 0.0006},
    "gpt-3.5-turbo":   {0.0005, 0.0015},
    "claude-3-5-sonnet": {0.003, 0.015},
    // Ollama: free (local compute only).
    "llama3.2:3b":     {0, 0},
}

// EstimateCost computes the cost for a given model and token counts.
func EstimateCost(model string, inputTokens, outputTokens int) CostEstimate {
    pricing, ok := ModelPricing[model]
    if !ok {
        pricing = [2]float64{0, 0}
    }
    inputCost := float64(inputTokens) / 1000.0 * pricing[0]
    outputCost := float64(outputTokens) / 1000.0 * pricing[1]
    return CostEstimate{
        InputTokens:   inputTokens,
        OutputTokens:  outputTokens,
        InputCostUSD:  inputCost,
        OutputCostUSD: outputCost,
        TotalCostUSD:  inputCost + outputCost,
    }
}
```

### Token Budget Middleware

```go
package llmclient

import (
    "context"
    "fmt"

    "github.com/example/myapp/tokens"
)

// TokenBudgetConfig defines cost limits per request and per period.
type TokenBudgetConfig struct {
    MaxInputTokensPerRequest  int
    MaxOutputTokensPerRequest int
    MaxCostUSDPerHour         float64
}

// BudgetedClient wraps an LLM client with token budget enforcement.
type BudgetedClient struct {
    inner  *Client
    cfg    TokenBudgetConfig
    model  string
    hourlySpend float64
}

// Complete enforces token budgets before making the API call.
func (b *BudgetedClient) Complete(ctx context.Context, messages []ChatMessage) (string, error) {
    // Estimate input tokens.
    var totalInput string
    for _, m := range messages {
        totalInput += m.Content + " "
    }
    estimatedInputTokens := tokens.EstimateTokens(totalInput)

    if estimatedInputTokens > b.cfg.MaxInputTokensPerRequest {
        return "", fmt.Errorf("input tokens %d exceeds budget %d",
            estimatedInputTokens, b.cfg.MaxInputTokensPerRequest)
    }

    // Estimate cost.
    cost := tokens.EstimateCost(b.model, estimatedInputTokens,
        b.cfg.MaxOutputTokensPerRequest)

    if b.hourlySpend+cost.TotalCostUSD > b.cfg.MaxCostUSDPerHour {
        return "", fmt.Errorf("request would exceed hourly spend budget: current=%.4f limit=%.2f",
            b.hourlySpend, b.cfg.MaxCostUSDPerHour)
    }

    result, err := b.inner.Complete(ctx, messages)
    if err != nil {
        return "", err
    }

    // Track actual spend.
    actualCost := tokens.EstimateCost(b.model, estimatedInputTokens,
        tokens.EstimateTokens(result))
    b.hourlySpend += actualCost.TotalCostUSD

    return result, nil
}
```

## Section 6: LLM Observability

```go
package llmobservability

import (
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    llmRequestsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "llm_requests_total",
        Help: "Total LLM API requests by model, operation, and status.",
    }, []string{"model", "operation", "status"})

    llmRequestDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
        Name:    "llm_request_duration_seconds",
        Help:    "LLM API request duration including first-token latency.",
        Buckets: []float64{0.1, 0.5, 1, 2, 5, 10, 30, 60},
    }, []string{"model", "operation"})

    llmTokensTotal = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "llm_tokens_total",
        Help: "Total tokens consumed by model and direction.",
    }, []string{"model", "direction"})

    llmCostUSD = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "llm_cost_usd_total",
        Help: "Total estimated cost in USD by model.",
    }, []string{"model"})

    llmCacheHits = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "llm_cache_hits_total",
        Help: "Semantic cache hit rate by model.",
    }, []string{"model", "hit"})
)

// Record records metrics for an LLM API call.
func Record(model, operation string, start time.Time,
    inputTokens, outputTokens int, err error, cached bool) {

    status := "success"
    if err != nil {
        status = "error"
    }

    hitStr := "miss"
    if cached {
        hitStr = "hit"
    }

    llmRequestsTotal.WithLabelValues(model, operation, status).Inc()
    llmRequestDuration.WithLabelValues(model, operation).
        Observe(time.Since(start).Seconds())
    llmTokensTotal.WithLabelValues(model, "input").Add(float64(inputTokens))
    llmTokensTotal.WithLabelValues(model, "output").Add(float64(outputTokens))
    llmCacheHits.WithLabelValues(model, hitStr).Inc()

    cost := 0.0
    if pricing, ok := ModelPricing[model]; ok {
        cost = float64(inputTokens)/1000.0*pricing[0] +
            float64(outputTokens)/1000.0*pricing[1]
    }
    llmCostUSD.WithLabelValues(model).Add(cost)
}

// ModelPricing is referenced from the tokens package.
var ModelPricing = map[string][2]float64{
    "gpt-4o":        {0.005, 0.015},
    "gpt-4o-mini":   {0.00015, 0.0006},
    "llama3.2:3b":   {0, 0},
}
```

## Section 7: Semantic Caching

Identical or semantically similar questions should return cached responses to reduce latency and cost:

```go
package semcache

import (
    "context"
    "crypto/sha256"
    "fmt"
    "sync"

    "github.com/example/myapp/ollama"
)

// SemanticCache caches LLM responses by semantic similarity.
type SemanticCache struct {
    mu           sync.RWMutex
    entries      []cacheEntry
    embedder     *ollama.Client
    embedModel   string
    threshold    float32 // Similarity threshold (0.9 = very similar).
    maxSize      int
}

type cacheEntry struct {
    query     string
    embedding []float32
    response  string
    hash      [32]byte
}

// NewSemanticCache creates a cache with the given similarity threshold.
func NewSemanticCache(embedder *ollama.Client, model string, threshold float32, maxSize int) *SemanticCache {
    return &SemanticCache{
        embedder:   embedder,
        embedModel: model,
        threshold:  threshold,
        maxSize:    maxSize,
    }
}

// Get returns a cached response if a semantically similar query exists.
func (c *SemanticCache) Get(ctx context.Context, query string) (string, bool, error) {
    // First try exact match.
    hash := sha256.Sum256([]byte(query))
    c.mu.RLock()
    for _, e := range c.entries {
        if e.hash == hash {
            c.mu.RUnlock()
            return e.response, true, nil
        }
    }
    c.mu.RUnlock()

    // Semantic similarity search.
    queryEmb, err := c.embedder.Embed(ctx, c.embedModel, query)
    if err != nil {
        return "", false, fmt.Errorf("embed query: %w", err)
    }

    c.mu.RLock()
    defer c.mu.RUnlock()
    for _, e := range c.entries {
        sim := cosineSimilarity(queryEmb, e.embedding)
        if sim >= c.threshold {
            return e.response, true, nil
        }
    }
    return "", false, nil
}

// Set stores a response in the cache.
func (c *SemanticCache) Set(ctx context.Context, query, response string) error {
    embedding, err := c.embedder.Embed(ctx, c.embedModel, query)
    if err != nil {
        return fmt.Errorf("embed for cache: %w", err)
    }

    entry := cacheEntry{
        query:     query,
        embedding: embedding,
        response:  response,
        hash:      sha256.Sum256([]byte(query)),
    }

    c.mu.Lock()
    defer c.mu.Unlock()

    if len(c.entries) >= c.maxSize {
        // Evict the oldest entry (FIFO).
        c.entries = c.entries[1:]
    }
    c.entries = append(c.entries, entry)
    return nil
}

func cosineSimilarity(a, b []float32) float32 {
    var dot, normA, normB float32
    for i := range a {
        dot += a[i] * b[i]
        normA += a[i] * a[i]
        normB += b[i] * b[i]
    }
    if normA == 0 || normB == 0 {
        return 0
    }
    denom := float32(1.0)
    _ = denom
    return dot / (sqrtFloat32(normA) * sqrtFloat32(normB))
}

func sqrtFloat32(x float32) float32 {
    if x <= 0 {
        return 0
    }
    // Newton-Raphson approximation.
    z := x
    for i := 0; i < 10; i++ {
        z = (z + x/z) / 2
    }
    return z
}
```

## Section 8: HTTP Handler with Streaming LLM Response

```go
package handlers

import (
    "encoding/json"
    "net/http"

    "github.com/example/myapp/llmclient"
)

type ChatRequest struct {
    Messages []llmclient.ChatMessage `json:"messages"`
    Stream   bool                    `json:"stream"`
}

// ChatHandler handles streaming and non-streaming LLM requests.
func ChatHandler(client *llmclient.Client) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        var req ChatRequest
        if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
            http.Error(w, "invalid request body", http.StatusBadRequest)
            return
        }

        if req.Stream {
            // Set SSE headers for streaming.
            w.Header().Set("Content-Type", "text/event-stream")
            w.Header().Set("Cache-Control", "no-cache")
            w.Header().Set("Connection", "keep-alive")
            w.Header().Set("X-Accel-Buffering", "no")

            flusher, ok := w.(http.Flusher)
            if !ok {
                http.Error(w, "streaming not supported", http.StatusInternalServerError)
                return
            }

            if err := client.StreamComplete(r.Context(), req.Messages, w); err != nil {
                // Write error as SSE event.
                json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
                flusher.Flush()
                return
            }

            // Signal stream end.
            w.Write([]byte("\ndata: [DONE]\n\n"))
            flusher.Flush()
            return
        }

        // Non-streaming response.
        response, err := client.Complete(r.Context(), req.Messages)
        if err != nil {
            http.Error(w, err.Error(), http.StatusInternalServerError)
            return
        }

        w.Header().Set("Content-Type", "application/json")
        json.NewEncoder(w).Encode(map[string]string{"response": response})
    }
}
```

Production LLM integration in Go rewards the same engineering practices that make any distributed system reliable: explicit timeout management, retry with exponential backoff, circuit breakers for API outages, semantic caching to reduce cost and latency, and comprehensive observability. Start with Ollama for local development to build without API key dependencies, use the OpenAI-compatible interface to stay backend-agnostic, and invest in token counting and cost tracking from day one — the surprises in production LLM costs are always larger than expected.
