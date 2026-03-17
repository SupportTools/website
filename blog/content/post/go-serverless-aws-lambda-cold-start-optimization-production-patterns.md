---
title: "Go Serverless on AWS Lambda: Cold Start Optimization and Production Patterns"
date: 2030-09-23T00:00:00-05:00
draft: false
tags: ["Go", "AWS Lambda", "Serverless", "Cold Start", "X-Ray", "OpenTelemetry", "AWS"]
categories:
- Go
- AWS
- Serverless
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise Go Lambda guide covering the Lambda runtime API, cold start reduction techniques, container image vs zip deployment, Lambda SnapStart, function URL vs API Gateway, structured logging, and distributed tracing with X-Ray and OpenTelemetry."
more_link: "yes"
url: "/go-serverless-aws-lambda-cold-start-optimization-production-patterns/"
---

Go is one of the best languages for AWS Lambda. Compiled binaries start faster than interpreted runtimes, memory footprint is minimal, and the static linking model eliminates dependency resolution at initialization time. Yet Go Lambda functions in production still suffer from cold start latency, noisy logs, and tracing gaps if not designed deliberately. This guide covers the full production stack: deployment strategies, cold start elimination, structured observability, and the architectural decisions that separate a prototype from an enterprise-grade serverless function.

<!--more-->

## Go Lambda Runtime Architecture

AWS Lambda runs Go functions using one of two runtime models:

1. **`provided.al2023` custom runtime**: The recommended approach. Your binary implements the Lambda Runtime API directly. This gives maximum control over initialization and produces the smallest possible binary.
2. **`go1.x` runtime (deprecated)**: Amazon Linux 2-based runtime with the legacy `aws-lambda-go` RPC model. AWS deprecated this in 2023; migrate to `provided.al2023`.

### Lambda Execution Lifecycle

Understanding the execution lifecycle is the foundation of cold start optimization:

```
Cold Start:
  1. Environment initialization (VM + container setup) - ~100-500ms (not controllable)
  2. Runtime initialization (your init() functions, global vars) - controllable
  3. Handler initialization (first invocation) - controllable

Warm Invocation:
  1. Handler execution only - your actual function code
```

The goal is to minimize phase 2 and ensure phase 3 work is deferred until actually needed.

## Project Structure and Dependencies

### Minimal Lambda Project Layout

```
my-lambda/
├── cmd/
│   └── handler/
│       └── main.go
├── internal/
│   ├── handler/
│   │   └── handler.go
│   ├── config/
│   │   └── config.go
│   └── telemetry/
│       └── telemetry.go
├── go.mod
├── go.sum
├── Makefile
└── template.yaml  # SAM template or CDK app
```

### go.mod with Essential Dependencies

```go
module github.com/myorg/my-lambda

go 1.23

require (
    github.com/aws/aws-lambda-go v1.47.0
    github.com/aws/aws-sdk-go-v2 v1.32.0
    github.com/aws/aws-sdk-go-v2/config v1.28.0
    github.com/aws/aws-sdk-go-v2/service/s3 v1.68.0
    github.com/aws/aws-sdk-go-v2/service/ssm v1.56.0
    github.com/aws/aws-xray-sdk-go v1.8.4
    go.opentelemetry.io/contrib/instrumentation/github.com/aws/aws-lambda-go/otellambda v0.56.0
    go.opentelemetry.io/otel v1.31.0
    go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc v1.31.0
    go.uber.org/zap v1.27.0
)
```

## Core Handler Implementation

### Idiomatic Lambda Handler with Structured Initialization

```go
// cmd/handler/main.go
package main

import (
    "context"
    "os"

    "github.com/aws/aws-lambda-go/lambda"
    "github.com/myorg/my-lambda/internal/config"
    "github.com/myorg/my-lambda/internal/handler"
    "github.com/myorg/my-lambda/internal/telemetry"
    "go.uber.org/zap"
)

var (
    // Global handler initialized once per container lifetime
    h *handler.Handler
)

func init() {
    // init() runs during cold start, before the first invocation
    // Keep this minimal - only do what must happen before ANY invocation

    cfg, err := config.Load()
    if err != nil {
        // Fatal during init means the container fails to initialize
        // Lambda will retry cold start up to 3 times before marking as failed
        zap.L().Fatal("failed to load config", zap.Error(err))
    }

    tp, err := telemetry.InitTracer(cfg)
    if err != nil {
        zap.L().Fatal("failed to init tracer", zap.Error(err))
    }
    _ = tp // Tracer provider stored globally by telemetry package

    h, err = handler.New(cfg)
    if err != nil {
        zap.L().Fatal("failed to initialize handler", zap.Error(err))
    }
}

func main() {
    lambda.Start(h.Handle)
}
```

```go
// internal/handler/handler.go
package handler

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    "github.com/aws/aws-lambda-go/events"
    "github.com/aws/aws-sdk-go-v2/aws"
    awsconfig "github.com/aws/aws-sdk-go-v2/config"
    "github.com/aws/aws-sdk-go-v2/service/s3"
    "github.com/myorg/my-lambda/internal/config"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.uber.org/zap"
)

type Handler struct {
    cfg    *config.Config
    s3     *s3.Client
    logger *zap.Logger
    tracer interface{ Start(context.Context, string, ...interface{}) (context.Context, interface{}) }
}

type Response struct {
    StatusCode int    `json:"statusCode"`
    Body       string `json:"body"`
    RequestID  string `json:"requestId"`
    Duration   string `json:"duration"`
}

func New(cfg *config.Config) (*Handler, error) {
    logger, err := zap.NewProduction()
    if err != nil {
        return nil, fmt.Errorf("creating logger: %w", err)
    }
    // Replace the global logger
    zap.ReplaceGlobals(logger)

    awsCfg, err := awsconfig.LoadDefaultConfig(context.Background(),
        awsconfig.WithRegion(cfg.AWSRegion),
    )
    if err != nil {
        return nil, fmt.Errorf("loading AWS config: %w", err)
    }

    return &Handler{
        cfg:    cfg,
        s3:     s3.NewFromConfig(awsCfg),
        logger: logger,
    }, nil
}

func (h *Handler) Handle(ctx context.Context, event events.APIGatewayProxyRequest) (events.APIGatewayProxyResponse, error) {
    start := time.Now()

    tracer := otel.Tracer("my-lambda")
    ctx, span := tracer.Start(ctx, "Handle")
    defer span.End()

    span.SetAttributes(
        attribute.String("http.method", event.HTTPMethod),
        attribute.String("http.path", event.Path),
        attribute.String("lambda.request_id", event.RequestContext.RequestID),
    )

    h.logger.Info("handling request",
        zap.String("method", event.HTTPMethod),
        zap.String("path", event.Path),
        zap.String("request_id", event.RequestContext.RequestID),
        zap.String("source_ip", event.RequestContext.Identity.SourceIP),
    )

    result, err := h.processRequest(ctx, event)
    if err != nil {
        h.logger.Error("request failed",
            zap.Error(err),
            zap.String("request_id", event.RequestContext.RequestID),
            zap.Duration("duration", time.Since(start)),
        )
        span.RecordError(err)
        return events.APIGatewayProxyResponse{
            StatusCode: 500,
            Body:       `{"error":"internal server error"}`,
            Headers: map[string]string{
                "Content-Type": "application/json",
            },
        }, nil // Return nil error to Lambda runtime - error is encoded in response
    }

    body, _ := json.Marshal(result)
    h.logger.Info("request completed",
        zap.Int("status", 200),
        zap.Duration("duration", time.Since(start)),
    )

    return events.APIGatewayProxyResponse{
        StatusCode: 200,
        Body:       string(body),
        Headers: map[string]string{
            "Content-Type":  "application/json",
            "X-Request-ID":  event.RequestContext.RequestID,
            "X-Duration-Ms": fmt.Sprintf("%d", time.Since(start).Milliseconds()),
        },
    }, nil
}

func (h *Handler) processRequest(ctx context.Context, event events.APIGatewayProxyRequest) (*Response, error) {
    // Business logic here
    return &Response{
        StatusCode: 200,
        Body:       "processed",
        RequestID:  event.RequestContext.RequestID,
    }, nil
}
```

## Cold Start Optimization Techniques

### 1. Minimize init() Work

The most impactful optimization is deferring expensive initialization:

```go
// BAD: Fetches secrets synchronously during cold start
func init() {
    dbPassword, _ := getSecretFromSSM("/prod/db/password")
    db, _ = sql.Open("postgres", "host=... password="+dbPassword)
    db.Ping() // Establishes connection pool
}

// GOOD: Lazy initialization with sync.Once
var (
    db     *sql.DB
    dbOnce sync.Once
    dbErr  error
)

func getDB(ctx context.Context) (*sql.DB, error) {
    dbOnce.Do(func() {
        password, err := getSecretFromSSM(ctx, "/prod/db/password")
        if err != nil {
            dbErr = err
            return
        }
        db, dbErr = sql.Open("postgres", "host=db.example.com password="+password)
        if dbErr == nil {
            dbErr = db.PingContext(ctx)
        }
    })
    return db, dbErr
}
```

### 2. Pre-initialize AWS SDK Clients

AWS SDK v2 initialization is cheap; pre-initialize clients to avoid per-invocation setup:

```go
var (
    s3Client  *s3.Client
    ssmClient *ssm.Client
    initOnce  sync.Once
)

func init() {
    // LoadDefaultConfig with Lambda uses the execution role credentials
    // This is fast because credentials come from the environment
    cfg, err := awsconfig.LoadDefaultConfig(context.Background())
    if err != nil {
        log.Fatalf("aws config: %v", err)
    }

    // Create clients once - they are goroutine-safe and reuse HTTP connections
    s3Client = s3.NewFromConfig(cfg)
    ssmClient = ssm.NewFromConfig(cfg)
}
```

### 3. HTTP Connection Reuse

Lambda containers reuse between warm invocations. HTTP connections in the default transport are pooled:

```go
// Custom HTTP transport with tuned timeouts
var httpClient = &http.Client{
    Timeout: 30 * time.Second,
    Transport: &http.Transport{
        MaxIdleConns:          100,
        MaxIdleConnsPerHost:   100,
        IdleConnTimeout:       90 * time.Second,
        TLSHandshakeTimeout:   10 * time.Second,
        ExpectContinueTimeout: 1 * time.Second,
        // Disable HTTP/2 if downstream doesn't support it well
        ForceAttemptHTTP2: true,
    },
}
```

### 4. Build Optimization for Smaller Binaries

Smaller binaries load faster. Use build flags to strip debug information:

```makefile
# Makefile
BINARY_NAME=bootstrap
GOARCH=arm64
GOOS=linux
LDFLAGS=-ldflags="-s -w"

build:
	GOARCH=$(GOARCH) GOOS=$(GOOS) go build \
	  $(LDFLAGS) \
	  -trimpath \
	  -o $(BINARY_NAME) \
	  ./cmd/handler/

	# Optional: compress with UPX (reduces cold start for large binaries)
	# upx --best --lzma $(BINARY_NAME)

zip: build
	zip deployment.zip $(BINARY_NAME)

.PHONY: build zip
```

ARM64 (`arm64`) is preferred over `amd64` for Lambda because Graviton2 instances have lower cold start times and cost 20% less.

## Container Image vs ZIP Deployment

### ZIP Deployment (Recommended for Most Cases)

ZIP packages up to 50MB uncompressed (250MB with layers) are the simplest deployment model:

```yaml
# SAM template for ZIP deployment
AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31

Globals:
  Function:
    Timeout: 30
    MemorySize: 512
    Architectures:
      - arm64
    Runtime: provided.al2023
    Environment:
      Variables:
        AWS_REGION: !Ref AWS::Region
        LOG_LEVEL: info

Resources:
  MyFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: ./
      Handler: bootstrap
      Role: !GetAtt LambdaRole.Arn
      ReservedConcurrentExecutions: 100
      Tracing: Active  # X-Ray tracing
      Layers:
        - !Sub arn:aws:lambda:${AWS::Region}:901920570463:layer:aws-otel-collector-arm64-ver-0-112-0:1
      Events:
        Api:
          Type: Api
          Properties:
            Path: /{proxy+}
            Method: ANY
      Environment:
        Variables:
          OTEL_SERVICE_NAME: my-function
          OTEL_EXPORTER_OTLP_ENDPOINT: http://localhost:4317
```

### Container Image Deployment

Container images (up to 10GB) benefit from caching layers that pre-warm cold starts. Use for large binaries or functions requiring specific system libraries:

```dockerfile
# Multi-stage build
FROM golang:1.23-alpine AS builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN GOARCH=arm64 GOOS=linux go build \
    -ldflags="-s -w" \
    -trimpath \
    -o bootstrap \
    ./cmd/handler/

# Lambda-provided base image includes the runtime interface client
FROM public.ecr.aws/lambda/provided:al2023-arm64

COPY --from=builder /app/bootstrap /var/task/bootstrap

# Lambda expects the handler to be named 'bootstrap' for provided runtime
CMD ["bootstrap"]
```

```bash
# Build and push to ECR
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin \
  123456789012.dkr.ecr.us-east-1.amazonaws.com

docker build --platform linux/arm64 -t my-lambda:latest .
docker tag my-lambda:latest \
  123456789012.dkr.ecr.us-east-1.amazonaws.com/my-lambda:latest
docker push 123456789012.dkr.ecr.us-east-1.amazonaws.com/my-lambda:latest
```

## Lambda SnapStart for Go

Lambda SnapStart (currently available for Java 21 managed runtime) has a Go equivalent through Firecracker microVM snapshot restore. For Go functions, the practical cold start optimization path is:

1. **Provisioned Concurrency**: Pre-warms containers before invocations
2. **ARM64 architecture**: Faster initialization than x86_64
3. **Minimized init() work**: Fastest path for pure Go functions

### Provisioned Concurrency Configuration

```yaml
# SAM template addition
MyFunctionAlias:
  Type: AWS::Lambda::Alias
  Properties:
    FunctionName: !Ref MyFunction
    FunctionVersion: !GetAtt MyFunction.Version
    Name: prod

MyFunctionProvisionedConcurrency:
  Type: AWS::ApplicationAutoScaling::ScalableTarget
  Properties:
    MaxCapacity: 100
    MinCapacity: 10
    ResourceId: !Sub function:${MyFunction}:prod
    ScalableDimension: lambda:function:ProvisionedConcurrency
    ServiceNamespace: lambda

MyFunctionScalingPolicy:
  Type: AWS::ApplicationAutoScaling::ScalingPolicy
  Properties:
    PolicyName: ProvisionedConcurrencyScaling
    PolicyType: TargetTrackingScaling
    ScalingTargetId: !Ref MyFunctionProvisionedConcurrency
    TargetTrackingScalingPolicyConfiguration:
      TargetValue: 0.7
      PredefinedMetricSpecification:
        PredefinedMetricType: LambdaProvisionedConcurrencyUtilization
```

## Function URL vs API Gateway

Function URLs provide direct HTTPS endpoints without API Gateway overhead. Choose based on requirements:

| Feature | Function URL | API Gateway v2 (HTTP) | API Gateway v1 (REST) |
|---|---|---|---|
| Latency overhead | Minimal | ~1ms | ~5ms |
| Cost | Free | $1/million | $3.50/million |
| Auth options | IAM, none | JWT, IAM, Lambda | Cognito, Lambda, IAM |
| Custom domain | Yes (via CloudFront) | Yes (native) | Yes (native) |
| Request transformation | No | Basic | Full VTL |
| WAF integration | Via CloudFront | Yes | Yes |
| Usage plans/throttling | No | Basic | Full |

### Function URL with IAM Auth

```go
// Function URL handler - receives raw HTTP events
package main

import (
    "context"
    "encoding/json"
    "net/http"

    "github.com/aws/aws-lambda-go/events"
    "github.com/aws/aws-lambda-go/lambda"
)

func handler(ctx context.Context, req events.LambdaFunctionURLRequest) (events.LambdaFunctionURLResponse, error) {
    // req.RequestContext.Authorizer.IAM contains the caller identity when IAM auth is used
    callerARN := req.RequestContext.Authorizer.IAM.UserARN

    response := map[string]string{
        "message": "hello",
        "caller":  callerARN,
    }
    body, _ := json.Marshal(response)

    return events.LambdaFunctionURLResponse{
        StatusCode: http.StatusOK,
        Body:       string(body),
        Headers: map[string]string{
            "Content-Type": "application/json",
        },
    }, nil
}

func main() {
    lambda.Start(handler)
}
```

## Structured Logging

### Zap Configuration for Lambda

Lambda logs flow to CloudWatch Logs. Structured JSON logs enable CloudWatch Insights queries:

```go
// internal/telemetry/logging.go
package telemetry

import (
    "os"

    "go.uber.org/zap"
    "go.uber.org/zap/zapcore"
)

func InitLogger(level string) (*zap.Logger, error) {
    logLevel, err := zapcore.ParseLevel(level)
    if err != nil {
        logLevel = zapcore.InfoLevel
    }

    config := zap.Config{
        Level:            zap.NewAtomicLevelAt(logLevel),
        Development:      false,
        Encoding:         "json",
        OutputPaths:      []string{"stdout"},
        ErrorOutputPaths: []string{"stderr"},
        EncoderConfig: zapcore.EncoderConfig{
            TimeKey:        "timestamp",
            LevelKey:       "level",
            NameKey:        "logger",
            CallerKey:      "caller",
            FunctionKey:    zapcore.OmitKey,
            MessageKey:     "message",
            StacktraceKey:  "stacktrace",
            LineEnding:     zapcore.DefaultLineEnding,
            EncodeLevel:    zapcore.LowercaseLevelEncoder,
            EncodeTime:     zapcore.ISO8601TimeEncoder,
            EncodeDuration: zapcore.MillisDurationEncoder,
            EncodeCaller:   zapcore.ShortCallerEncoder,
        },
    }

    return config.Build(
        zap.AddCaller(),
        zap.Fields(
            // Static fields added to every log entry
            zap.String("service", os.Getenv("AWS_LAMBDA_FUNCTION_NAME")),
            zap.String("version", os.Getenv("AWS_LAMBDA_FUNCTION_VERSION")),
            zap.String("region", os.Getenv("AWS_REGION")),
        ),
    )
}
```

### CloudWatch Insights Query Examples

```
# Error rate by function version
fields @timestamp, @message
| filter level = "error"
| stats count() as errors by version, bin(5m)
| sort @timestamp desc

# P99 latency from structured duration fields
fields @timestamp, duration_ms
| filter ispresent(duration_ms)
| stats pct(duration_ms, 99) as p99, avg(duration_ms) as avg by bin(5m)

# Cold start detection (Lambda adds INIT_START log line)
filter @message like /INIT_START/
| stats count() as cold_starts by bin(1h)
```

## Distributed Tracing with X-Ray and OpenTelemetry

### X-Ray Native Integration

```go
// internal/telemetry/xray.go
package telemetry

import (
    "context"
    "net/http"

    "github.com/aws/aws-xray-sdk-go/instrumentation/awsv2"
    "github.com/aws/aws-xray-sdk-go/xray"
    awsconfig "github.com/aws/aws-sdk-go-v2/config"
)

func InitXRay() error {
    return xray.Configure(xray.Config{
        DaemonAddr:     "127.0.0.1:2000", // X-Ray daemon runs as Lambda extension
        ServiceVersion: "1.0.0",
        LogLevel:       "warn",
    })
}

// Instrument AWS SDK v2 calls
func NewAWSConfig(ctx context.Context) (aws.Config, error) {
    cfg, err := awsconfig.LoadDefaultConfig(ctx)
    if err != nil {
        return cfg, err
    }
    // Instrument all AWS SDK calls with X-Ray
    awsv2.AWSV2Instrumentor(&cfg.APIOptions)
    return cfg, nil
}

// Instrument outgoing HTTP calls
func NewInstrumentedHTTPClient() *http.Client {
    return xray.Client(nil) // nil uses default http.Client
}
```

### OpenTelemetry Integration with ADOT

The AWS Distro for OpenTelemetry (ADOT) Lambda layer is preferred for new deployments because it provides vendor-neutral tracing:

```go
// internal/telemetry/otel.go
package telemetry

import (
    "context"
    "fmt"
    "os"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
    "go.opentelemetry.io/otel/propagation"
    "go.opentelemetry.io/otel/sdk/resource"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
)

func InitTracer(ctx context.Context) (*sdktrace.TracerProvider, error) {
    res, err := resource.New(ctx,
        resource.WithAttributes(
            semconv.ServiceName(os.Getenv("OTEL_SERVICE_NAME")),
            semconv.ServiceVersion(os.Getenv("AWS_LAMBDA_FUNCTION_VERSION")),
            semconv.CloudRegion(os.Getenv("AWS_REGION")),
            semconv.FaaSName(os.Getenv("AWS_LAMBDA_FUNCTION_NAME")),
        ),
    )
    if err != nil {
        return nil, fmt.Errorf("creating resource: %w", err)
    }

    // ADOT collector runs as a Lambda layer and listens on localhost:4317
    conn, err := grpc.NewClient(
        os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT"),
        grpc.WithTransportCredentials(insecure.NewCredentials()),
    )
    if err != nil {
        return nil, fmt.Errorf("creating grpc connection: %w", err)
    }

    exporter, err := otlptracegrpc.New(ctx,
        otlptracegrpc.WithGRPCConn(conn),
        otlptracegrpc.WithTimeout(5*time.Second),
    )
    if err != nil {
        return nil, fmt.Errorf("creating exporter: %w", err)
    }

    tp := sdktrace.NewTracerProvider(
        sdktrace.WithBatcher(exporter,
            sdktrace.WithBatchTimeout(5*time.Second),
            sdktrace.WithMaxExportBatchSize(512),
        ),
        sdktrace.WithResource(res),
        sdktrace.WithSampler(sdktrace.AlwaysSample()),
    )

    otel.SetTracerProvider(tp)
    otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
        propagation.TraceContext{},
        propagation.Baggage{},
    ))

    return tp, nil
}
```

### Lambda Extension for Flushing Telemetry

Lambda truncates execution when the handler returns. Telemetry must be flushed before the invocation ends:

```go
func main() {
    ctx := context.Background()

    tp, err := telemetry.InitTracer(ctx)
    if err != nil {
        log.Fatalf("tracer init: %v", err)
    }

    // Wrap handler to flush traces after each invocation
    wrappedHandler := func(ctx context.Context, event events.APIGatewayProxyRequest) (events.APIGatewayProxyResponse, error) {
        defer func() {
            // Flush with a 5-second deadline before Lambda freezes the process
            flushCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
            defer cancel()
            if err := tp.ForceFlush(flushCtx); err != nil {
                zap.L().Warn("trace flush incomplete", zap.Error(err))
            }
        }()
        return h.Handle(ctx, event)
    }

    lambda.Start(wrappedHandler)
}
```

## Configuration Management

### SSM Parameter Store Integration

```go
// internal/config/config.go
package config

import (
    "context"
    "fmt"
    "os"
    "sync"
    "time"

    "github.com/aws/aws-sdk-go-v2/aws"
    awsconfig "github.com/aws/aws-sdk-go-v2/config"
    "github.com/aws/aws-sdk-go-v2/service/ssm"
)

type Config struct {
    AWSRegion    string
    Environment  string
    DatabaseURL  string
    APIKey       string
}

type paramCache struct {
    value     string
    fetchedAt time.Time
    mu        sync.RWMutex
}

var (
    paramCaches = make(map[string]*paramCache)
    cacheTTL    = 5 * time.Minute
    ssmClient   *ssm.Client
    ssmOnce     sync.Once
)

func getSSMClient() *ssm.Client {
    ssmOnce.Do(func() {
        cfg, _ := awsconfig.LoadDefaultConfig(context.Background())
        ssmClient = ssm.NewFromConfig(cfg)
    })
    return ssmClient
}

func getParameter(ctx context.Context, name string) (string, error) {
    cache, ok := paramCaches[name]
    if !ok {
        cache = &paramCache{}
        paramCaches[name] = cache
    }

    cache.mu.RLock()
    if time.Since(cache.fetchedAt) < cacheTTL && cache.value != "" {
        val := cache.value
        cache.mu.RUnlock()
        return val, nil
    }
    cache.mu.RUnlock()

    cache.mu.Lock()
    defer cache.mu.Unlock()

    // Double-check after acquiring write lock
    if time.Since(cache.fetchedAt) < cacheTTL && cache.value != "" {
        return cache.value, nil
    }

    result, err := getSSMClient().GetParameter(ctx, &ssm.GetParameterInput{
        Name:           aws.String(name),
        WithDecryption: aws.Bool(true),
    })
    if err != nil {
        return "", fmt.Errorf("getting parameter %s: %w", name, err)
    }

    cache.value = aws.ToString(result.Parameter.Value)
    cache.fetchedAt = time.Now()
    return cache.value, nil
}

func Load() (*Config, error) {
    ctx := context.Background()
    env := os.Getenv("ENVIRONMENT")
    if env == "" {
        env = "dev"
    }

    dbURL, err := getParameter(ctx, fmt.Sprintf("/%s/myapp/database-url", env))
    if err != nil {
        return nil, fmt.Errorf("database URL: %w", err)
    }

    apiKey, err := getParameter(ctx, fmt.Sprintf("/%s/myapp/api-key", env))
    if err != nil {
        return nil, fmt.Errorf("api key: %w", err)
    }

    return &Config{
        AWSRegion:   os.Getenv("AWS_REGION"),
        Environment: env,
        DatabaseURL: dbURL,
        APIKey:      apiKey,
    }, nil
}
```

## Event Source Mapping Patterns

### SQS Consumer

```go
func sqsHandler(ctx context.Context, event events.SQSEvent) (events.SQSEventResponse, error) {
    var failures []events.SQSBatchItemFailure

    for _, record := range event.Records {
        if err := processMessage(ctx, record); err != nil {
            zap.L().Error("failed to process message",
                zap.String("message_id", record.MessageId),
                zap.Error(err),
            )
            // Return failed message IDs for partial batch failure reporting
            // Requires "ReportBatchItemFailures" function response type in Lambda config
            failures = append(failures, events.SQSBatchItemFailure{
                ItemIdentifier: record.MessageId,
            })
        }
    }

    return events.SQSEventResponse{
        BatchItemFailures: failures,
    }, nil
}

func processMessage(ctx context.Context, record events.SQSMessage) error {
    tracer := otel.Tracer("sqs-consumer")
    ctx, span := tracer.Start(ctx, "processMessage",
        trace.WithAttributes(
            attribute.String("sqs.message_id", record.MessageId),
            attribute.String("sqs.queue_arn", record.EventSourceARN),
        ),
    )
    defer span.End()

    var payload MyPayload
    if err := json.Unmarshal([]byte(record.Body), &payload); err != nil {
        // Malformed messages should go to DLQ, not be retried
        span.RecordError(err)
        zap.L().Error("malformed message body",
            zap.String("message_id", record.MessageId),
            zap.String("body_preview", record.Body[:min(100, len(record.Body))]),
            zap.Error(err),
        )
        return nil // Return nil to prevent retry - message goes to DLQ via maxReceiveCount
    }

    return processPayload(ctx, payload)
}
```

## Testing Lambda Handlers

### Unit Testing Without AWS Dependencies

```go
// internal/handler/handler_test.go
package handler_test

import (
    "context"
    "encoding/json"
    "testing"

    "github.com/aws/aws-lambda-go/events"
    "github.com/myorg/my-lambda/internal/handler"
    "github.com/myorg/my-lambda/internal/config"
)

func TestHandleSuccess(t *testing.T) {
    cfg := &config.Config{
        AWSRegion:   "us-east-1",
        Environment: "test",
    }

    h, err := handler.NewWithDeps(cfg, &mockS3Client{})
    if err != nil {
        t.Fatalf("creating handler: %v", err)
    }

    req := events.APIGatewayProxyRequest{
        HTTPMethod: "GET",
        Path:       "/health",
        RequestContext: events.APIGatewayProxyRequestContext{
            RequestID: "test-request-id",
        },
    }

    resp, err := h.Handle(context.Background(), req)
    if err != nil {
        t.Fatalf("unexpected error: %v", err)
    }

    if resp.StatusCode != 200 {
        t.Errorf("expected 200, got %d, body: %s", resp.StatusCode, resp.Body)
    }

    var body map[string]interface{}
    if err := json.Unmarshal([]byte(resp.Body), &body); err != nil {
        t.Fatalf("invalid JSON response: %v", err)
    }
}

// Integration test using Lambda local invoke
func TestLambdaInvokeLocal(t *testing.T) {
    if testing.Short() {
        t.Skip("skipping integration test")
    }
    // Use SAM local or Lambda Test Tool for integration testing
}
```

## Production Deployment Checklist

Before deploying Go Lambda functions to production:

- Set `GOARCH=arm64` and `GOOS=linux` - Graviton2 provides lower cold starts and 20% cost reduction
- Build with `-ldflags="-s -w" -trimpath` to minimize binary size
- Configure structured JSON logging with Lambda request context fields
- Set up X-Ray or ADOT tracing with explicit flush before handler return
- Use SSM Parameter Store with in-memory caching (5-minute TTL) for secrets
- Enable Provisioned Concurrency for latency-sensitive endpoints
- Configure SQS event sources with `ReportBatchItemFailures` for partial batch failure handling
- Set memory allocation based on actual profiling, not guessing - higher memory also means more CPU
- Configure DLQ on all async event sources
- Set `ReservedConcurrentExecutions` to prevent runaway scaling consuming all account concurrency
- Enable Lambda Insights layer for enhanced CloudWatch metrics

The combination of Go's fast startup time, ARM64 architecture, and careful initialization design can routinely achieve cold start times under 200ms for functions with no external dependencies and under 500ms for functions requiring SSM parameter fetches and database connections.
