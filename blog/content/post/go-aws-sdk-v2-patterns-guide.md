---
title: "Go AWS SDK v2 Patterns: Credential Management, Retry Logic, and Service Client Optimization"
date: 2028-04-30T00:00:00-05:00
draft: false
tags: ["Go", "AWS", "SDK", "S3", "DynamoDB", "Credentials"]
categories: ["Go", "AWS"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production Go patterns for the AWS SDK v2 covering IAM credential chains, IRSA configuration, custom retry logic, client-side endpoint optimization, S3 multipart operations, DynamoDB transactions, and testing with localstack."
more_link: "yes"
url: "/go-aws-sdk-v2-patterns-guide/"
---

The AWS SDK for Go v2 brought a redesigned API with better performance, context propagation, and middleware architecture. This guide covers the patterns production teams need: proper credential chain setup including IRSA, implementing resilient retry policies, optimizing client connection pools, handling large S3 objects, building DynamoDB transaction patterns, and testing without AWS accounts.

<!--more-->

# Go AWS SDK v2 Patterns: Credential Management, Retry Logic, and Service Client Optimization

## SDK v2 Architecture

AWS SDK v2 separates configuration loading, authentication, and service clients:

- **aws.Config**: Loaded once, shared across multiple clients
- **Credentials provider**: Pluggable authentication (static, environment, IRSA, EC2 instance profile)
- **HTTP client**: Shared transport with connection pooling
- **Middleware stack**: Per-request customization (retry, logging, signing, endpoint resolution)
- **Paginators**: Type-safe helpers for paginated API operations

```bash
go get github.com/aws/aws-sdk-go-v2@latest
go get github.com/aws/aws-sdk-go-v2/config@latest
go get github.com/aws/aws-sdk-go-v2/service/s3@latest
go get github.com/aws/aws-sdk-go-v2/service/dynamodb@latest
go get github.com/aws/aws-sdk-go-v2/service/secretsmanager@latest
go get github.com/aws/aws-sdk-go-v2/credentials/stscreds@latest
```

## Credential Management

### Production Credential Chain

```go
// internal/awsconfig/config.go
package awsconfig

import (
    "context"
    "fmt"
    "net/http"
    "time"

    "github.com/aws/aws-sdk-go-v2/aws"
    "github.com/aws/aws-sdk-go-v2/aws/retry"
    "github.com/aws/aws-sdk-go-v2/config"
    "github.com/aws/aws-sdk-go-v2/credentials"
    "github.com/aws/aws-sdk-go-v2/credentials/stscreds"
    "github.com/aws/aws-sdk-go-v2/service/sts"
)

type ClientConfig struct {
    Region          string
    RoleARN         string        // For cross-account or IRSA
    RoleSessionName string
    MaxRetries      int
    RetryMode       aws.RetryMode
    HTTPTimeout     time.Duration
    ConnectTimeout  time.Duration
}

// NewAWSConfig creates an aws.Config for production use.
// It uses the standard credential chain:
// 1. Environment variables (AWS_ACCESS_KEY_ID, etc.)
// 2. Shared credentials file (~/.aws/credentials)
// 3. IAM role for service accounts (IRSA) via web identity token
// 4. EC2 instance profile / ECS task role
func NewAWSConfig(ctx context.Context, cfg ClientConfig) (aws.Config, error) {
    if cfg.Region == "" {
        cfg.Region = "us-east-1"
    }
    if cfg.MaxRetries <= 0 {
        cfg.MaxRetries = 3
    }
    if cfg.HTTPTimeout <= 0 {
        cfg.HTTPTimeout = 30 * time.Second
    }
    if cfg.ConnectTimeout <= 0 {
        cfg.ConnectTimeout = 5 * time.Second
    }

    httpClient := &http.Client{
        Transport: &http.Transport{
            MaxIdleConns:        200,
            MaxIdleConnsPerHost: 50,
            IdleConnTimeout:     90 * time.Second,
            TLSHandshakeTimeout: cfg.ConnectTimeout,
            ResponseHeaderTimeout: cfg.HTTPTimeout,
            DisableKeepAlives:   false,
        },
        Timeout: cfg.HTTPTimeout,
    }

    loadOpts := []func(*config.LoadOptions) error{
        config.WithRegion(cfg.Region),
        config.WithHTTPClient(httpClient),
        config.WithRetryer(func() aws.Retryer {
            return retry.NewStandard(func(o *retry.StandardOptions) {
                o.MaxAttempts = cfg.MaxRetries + 1
                o.MaxBackoff = 30 * time.Second
                o.RateLimiter = retry.NewTokenRateLimit(500) // Token bucket
            })
        }),
    }

    awsCfg, err := config.LoadDefaultConfig(ctx, loadOpts...)
    if err != nil {
        return aws.Config{}, fmt.Errorf("loading AWS config: %w", err)
    }

    // Optionally assume a role
    if cfg.RoleARN != "" {
        stsClient := sts.NewFromConfig(awsCfg)
        sessionName := cfg.RoleSessionName
        if sessionName == "" {
            sessionName = "go-service"
        }
        awsCfg.Credentials = aws.NewCredentialsCache(
            stscreds.NewAssumeRoleProvider(stsClient, cfg.RoleARN, func(o *stscreds.AssumeRoleOptions) {
                o.RoleSessionName = sessionName
                o.Duration = 1 * time.Hour
            }),
        )
    }

    return awsCfg, nil
}
```

### IRSA (IAM Roles for Service Accounts) Setup

IRSA allows Kubernetes pods to assume IAM roles without static credentials:

```go
// IRSA uses the WebIdentityTokenFileCredentialsProvider automatically
// when these environment variables are set by Kubernetes:
// AWS_WEB_IDENTITY_TOKEN_FILE=/var/run/secrets/eks.amazonaws.com/serviceaccount/token
// AWS_ROLE_ARN=arn:aws:iam::123456789:role/my-service-role
// AWS_ROLE_SESSION_NAME=my-service

// The standard config.LoadDefaultConfig will pick these up automatically.
// No special code is needed if the pod's service account is annotated.

// Verify credentials are working
func VerifyCredentials(ctx context.Context, cfg aws.Config) error {
    stsClient := sts.NewFromConfig(cfg)
    identity, err := stsClient.GetCallerIdentity(ctx, &sts.GetCallerIdentityInput{})
    if err != nil {
        return fmt.Errorf("credential verification failed: %w", err)
    }
    fmt.Printf("Running as: %s (account: %s)\n",
        aws.ToString(identity.Arn),
        aws.ToString(identity.Account))
    return nil
}
```

```yaml
# Kubernetes ServiceAccount with IRSA annotation
apiVersion: v1
kind: ServiceAccount
metadata:
  name: my-service
  namespace: production
  annotations:
    eks.amazonaws.com/role-arn: "arn:aws:iam::123456789012:role/my-service-role"
---
# Pod spec
spec:
  serviceAccountName: my-service
  containers:
    - name: app
      # The EKS mutating webhook automatically mounts the token and sets env vars
```

### Cross-Account Access Pattern

```go
package awsconfig

import (
    "context"
    "fmt"
    "time"

    "github.com/aws/aws-sdk-go-v2/aws"
    "github.com/aws/aws-sdk-go-v2/credentials/stscreds"
    "github.com/aws/aws-sdk-go-v2/service/sts"
)

// ChainedRoleConfig assumes a chain of roles (useful for cross-org access).
type ChainedRoleConfig struct {
    BaseConfig aws.Config
    RoleChain  []string // Roles to assume in order
}

func AssumeRoleChain(ctx context.Context, cfg ChainedRoleConfig) (aws.Config, error) {
    current := cfg.BaseConfig

    for i, roleARN := range cfg.RoleChain {
        stsClient := sts.NewFromConfig(current)
        current.Credentials = aws.NewCredentialsCache(
            stscreds.NewAssumeRoleProvider(stsClient, roleARN, func(o *stscreds.AssumeRoleOptions) {
                o.RoleSessionName = fmt.Sprintf("chain-hop-%d", i)
                o.Duration = 1 * time.Hour
                o.ExternalID = nil // Set if required by role trust policy
            }),
        )
    }

    return current, nil
}
```

## Custom Retry Logic

### Retry with Jitter

```go
package awsretry

import (
    "context"
    "math/rand"
    "time"

    "github.com/aws/aws-sdk-go-v2/aws"
    "github.com/aws/aws-sdk-go-v2/aws/retry"
    smithy "github.com/aws/smithy-go"
)

// NewProductionRetryer creates a retryer with full jitter and custom conditions.
func NewProductionRetryer(maxAttempts int) aws.Retryer {
    return retry.NewStandard(func(o *retry.StandardOptions) {
        o.MaxAttempts = maxAttempts
        o.MaxBackoff = 60 * time.Second

        // Custom backoff: full jitter
        o.Backoff = retry.BackoffDelayFunc(func(attempt int, err error) (time.Duration, error) {
            base := time.Duration(1<<uint(attempt)) * 100 * time.Millisecond
            if base > 30*time.Second {
                base = 30 * time.Second
            }
            // Full jitter: random delay between 0 and base
            jitter := time.Duration(rand.Int63n(int64(base)))
            return jitter, nil
        })

        // Custom retry conditions
        o.Retryables = append(o.Retryables, retry.IsErrorRetryableFunc(func(err error) aws.Ternary {
            var apiErr smithy.APIError
            if ok := smithy.As(err, &apiErr); ok {
                switch apiErr.ErrorCode() {
                case "ProvisionedThroughputExceededException",
                    "RequestLimitExceeded",
                    "SlowDown",
                    "ServiceUnavailable":
                    return aws.TrueTernary
                case "InvalidSignatureException",
                    "AuthFailure":
                    return aws.FalseTernary // Don't retry auth errors
                }
            }
            return aws.UnknownTernary // Use default behavior
        }))
    })
}
```

### Circuit Breaker Wrapper

```go
package circuitbreaker

import (
    "context"
    "errors"
    "sync"
    "time"
)

type State int

const (
    StateClosed State = iota // Normal operation
    StateOpen                // Circuit open - fast failing
    StateHalfOpen            // Testing recovery
)

var ErrCircuitOpen = errors.New("circuit breaker is open")

type CircuitBreaker struct {
    mu              sync.RWMutex
    state           State
    failures        int
    successes       int
    lastStateChange time.Time
    threshold       int
    resetTimeout    time.Duration
    halfOpenMax     int
}

func NewCircuitBreaker(threshold int, resetTimeout time.Duration) *CircuitBreaker {
    return &CircuitBreaker{
        state:        StateClosed,
        threshold:    threshold,
        resetTimeout: resetTimeout,
        halfOpenMax:  3,
    }
}

func (cb *CircuitBreaker) Execute(ctx context.Context, fn func(context.Context) error) error {
    cb.mu.RLock()
    state := cb.state
    lastChange := cb.lastStateChange
    cb.mu.RUnlock()

    switch state {
    case StateOpen:
        if time.Since(lastChange) > cb.resetTimeout {
            cb.transition(StateHalfOpen)
        } else {
            return ErrCircuitOpen
        }
    }

    err := fn(ctx)

    cb.mu.Lock()
    defer cb.mu.Unlock()

    if err != nil {
        cb.failures++
        cb.successes = 0
        if cb.failures >= cb.threshold {
            cb.transitionLocked(StateOpen)
        }
        return err
    }

    cb.successes++
    cb.failures = 0
    if cb.state == StateHalfOpen && cb.successes >= cb.halfOpenMax {
        cb.transitionLocked(StateClosed)
    }

    return nil
}

func (cb *CircuitBreaker) transition(state State) {
    cb.mu.Lock()
    defer cb.mu.Unlock()
    cb.transitionLocked(state)
}

func (cb *CircuitBreaker) transitionLocked(state State) {
    cb.state = state
    cb.lastStateChange = time.Now()
    cb.failures = 0
    cb.successes = 0
}
```

## S3 Operations

### Client Initialization with Transfer Manager

```go
package s3ops

import (
    "context"
    "fmt"
    "io"
    "os"
    "sync"

    "github.com/aws/aws-sdk-go-v2/aws"
    "github.com/aws/aws-sdk-go-v2/feature/s3/manager"
    "github.com/aws/aws-sdk-go-v2/service/s3"
    "github.com/aws/aws-sdk-go-v2/service/s3/types"
)

type S3Client struct {
    client   *s3.Client
    uploader *manager.Uploader
    downloader *manager.Downloader
    bucket   string
}

func NewS3Client(cfg aws.Config, bucket string) *S3Client {
    client := s3.NewFromConfig(cfg,
        func(o *s3.Options) {
            // Use path-style addressing for compatibility with non-AWS S3
            o.UsePathStyle = false
            // Enable transfer acceleration if needed
            o.UseAccelerate = false
        },
    )

    uploader := manager.NewUploader(client, func(u *manager.UploadOptions) {
        u.PartSize = 10 * 1024 * 1024 // 10 MiB parts
        u.Concurrency = 5             // 5 parallel upload streams
        u.LeavePartsOnError = false   // Clean up on failure
    })

    downloader := manager.NewDownloader(client, func(d *manager.DownloadOptions) {
        d.PartSize = 10 * 1024 * 1024
        d.Concurrency = 5
    })

    return &S3Client{
        client:     client,
        uploader:   uploader,
        downloader: downloader,
        bucket:     bucket,
    }
}

// UploadFile uploads a file with server-side encryption and metadata.
func (c *S3Client) UploadFile(
    ctx context.Context,
    key string,
    r io.Reader,
    contentType string,
    metadata map[string]string,
) (*manager.UploadOutput, error) {
    input := &s3.PutObjectInput{
        Bucket:               aws.String(c.bucket),
        Key:                  aws.String(key),
        Body:                 r,
        ContentType:          aws.String(contentType),
        ServerSideEncryption: types.ServerSideEncryptionAwsKms,
        Metadata:             metadata,
        // Prevent public access regardless of bucket policy
        ACL: types.ObjectCannedACLPrivate,
    }

    result, err := c.uploader.Upload(ctx, input)
    if err != nil {
        return nil, fmt.Errorf("uploading %s: %w", key, err)
    }

    return result, nil
}

// DownloadToFile downloads an S3 object to a local file.
func (c *S3Client) DownloadToFile(ctx context.Context, key, localPath string) (int64, error) {
    f, err := os.Create(localPath)
    if err != nil {
        return 0, fmt.Errorf("creating local file: %w", err)
    }
    defer f.Close()

    n, err := c.downloader.Download(ctx, f, &s3.GetObjectInput{
        Bucket: aws.String(c.bucket),
        Key:    aws.String(key),
    })
    if err != nil {
        return 0, fmt.Errorf("downloading %s: %w", key, err)
    }

    return n, nil
}

// ListObjects returns all keys with a given prefix using pagination.
func (c *S3Client) ListObjects(ctx context.Context, prefix string) ([]string, error) {
    paginator := s3.NewListObjectsV2Paginator(c.client, &s3.ListObjectsV2Input{
        Bucket: aws.String(c.bucket),
        Prefix: aws.String(prefix),
    })

    var keys []string

    for paginator.HasMorePages() {
        page, err := paginator.NextPage(ctx)
        if err != nil {
            return nil, fmt.Errorf("listing objects with prefix %s: %w", prefix, err)
        }

        for _, obj := range page.Contents {
            keys = append(keys, aws.ToString(obj.Key))
        }
    }

    return keys, nil
}

// CopyBatch copies multiple objects concurrently.
func (c *S3Client) CopyBatch(
    ctx context.Context,
    copies map[string]string, // src -> dst key
    concurrency int,
) error {
    sem := make(chan struct{}, concurrency)
    var wg sync.WaitGroup
    errs := make(chan error, len(copies))

    for src, dst := range copies {
        wg.Add(1)
        sem <- struct{}{}

        go func(srcKey, dstKey string) {
            defer wg.Done()
            defer func() { <-sem }()

            _, err := c.client.CopyObject(ctx, &s3.CopyObjectInput{
                Bucket:               aws.String(c.bucket),
                CopySource:           aws.String(fmt.Sprintf("%s/%s", c.bucket, srcKey)),
                Key:                  aws.String(dstKey),
                ServerSideEncryption: types.ServerSideEncryptionAwsKms,
            })
            if err != nil {
                errs <- fmt.Errorf("copying %s to %s: %w", srcKey, dstKey, err)
            }
        }(src, dst)
    }

    wg.Wait()
    close(errs)

    var combinedErr error
    for err := range errs {
        if combinedErr == nil {
            combinedErr = err
        }
    }
    return combinedErr
}

// GeneratePresignedURL creates a time-limited URL for client uploads.
func (c *S3Client) GeneratePresignedURL(
    ctx context.Context,
    key string,
    expiry time.Duration,
) (string, error) {
    presignClient := s3.NewPresignClient(c.client, func(o *s3.PresignOptions) {
        o.Expires = expiry
    })

    req, err := presignClient.PresignPutObject(ctx, &s3.PutObjectInput{
        Bucket: aws.String(c.bucket),
        Key:    aws.String(key),
    })
    if err != nil {
        return "", fmt.Errorf("presigning upload URL for %s: %w", key, err)
    }

    return req.URL, nil
}
```

## DynamoDB Patterns

### Single-Table Design Client

```go
package dynamoops

import (
    "context"
    "fmt"

    "github.com/aws/aws-sdk-go-v2/aws"
    "github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
    "github.com/aws/aws-sdk-go-v2/feature/dynamodb/expression"
    "github.com/aws/aws-sdk-go-v2/service/dynamodb"
    "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

type DynamoClient struct {
    client *dynamodb.Client
    table  string
}

func NewDynamoClient(cfg aws.Config, table string) *DynamoClient {
    client := dynamodb.NewFromConfig(cfg,
        func(o *dynamodb.Options) {
            // Enable endpoint discovery for better routing
            o.EndpointOptions.UseFIPSEndpoint = aws.FIPSEndpointStateDisabled
        },
    )
    return &DynamoClient{client: client, table: table}
}

// PutItem writes a typed struct to DynamoDB.
func (c *DynamoClient) PutItem(ctx context.Context, item interface{}) error {
    av, err := attributevalue.MarshalMap(item)
    if err != nil {
        return fmt.Errorf("marshaling item: %w", err)
    }

    _, err = c.client.PutItem(ctx, &dynamodb.PutItemInput{
        TableName: aws.String(c.table),
        Item:      av,
        // Conditional write: only if item doesn't exist
        ConditionExpression: aws.String("attribute_not_exists(PK)"),
    })
    if err != nil {
        var cce *types.ConditionalCheckFailedException
        if ok := errors.As(err, &cce); ok {
            return fmt.Errorf("item already exists: %w", ErrConflict)
        }
        return fmt.Errorf("putting item: %w", err)
    }

    return nil
}

// GetItem retrieves a typed item by primary key.
func (c *DynamoClient) GetItem(ctx context.Context, pk, sk string, out interface{}) error {
    result, err := c.client.GetItem(ctx, &dynamodb.GetItemInput{
        TableName: aws.String(c.table),
        Key: map[string]types.AttributeValue{
            "PK": &types.AttributeValueMemberS{Value: pk},
            "SK": &types.AttributeValueMemberS{Value: sk},
        },
        // Strongly consistent read for critical paths
        ConsistentRead: aws.Bool(true),
    })
    if err != nil {
        return fmt.Errorf("getting item %s/%s: %w", pk, sk, err)
    }

    if result.Item == nil {
        return ErrNotFound
    }

    return attributevalue.UnmarshalMap(result.Item, out)
}

// TransactWrite executes multiple writes atomically.
func (c *DynamoClient) TransactWrite(ctx context.Context, ops []TransactOp) error {
    items := make([]types.TransactWriteItem, 0, len(ops))

    for _, op := range ops {
        switch op.Type {
        case OpPut:
            av, err := attributevalue.MarshalMap(op.Item)
            if err != nil {
                return fmt.Errorf("marshaling transact item: %w", err)
            }
            item := types.TransactWriteItem{
                Put: &types.Put{
                    TableName:           aws.String(c.table),
                    Item:                av,
                    ConditionExpression: op.Condition,
                },
            }
            items = append(items, item)

        case OpUpdate:
            builder := expression.NewBuilder()
            if op.Update != nil {
                builder = builder.WithUpdate(*op.Update)
            }
            if op.CondExpr != nil {
                builder = builder.WithCondition(*op.CondExpr)
            }

            expr, err := builder.Build()
            if err != nil {
                return fmt.Errorf("building update expression: %w", err)
            }

            key, err := attributevalue.MarshalMap(op.Key)
            if err != nil {
                return fmt.Errorf("marshaling key: %w", err)
            }

            item := types.TransactWriteItem{
                Update: &types.Update{
                    TableName:                 aws.String(c.table),
                    Key:                       key,
                    UpdateExpression:          expr.Update(),
                    ConditionExpression:       expr.Condition(),
                    ExpressionAttributeNames:  expr.Names(),
                    ExpressionAttributeValues: expr.Values(),
                },
            }
            items = append(items, item)

        case OpDelete:
            key, err := attributevalue.MarshalMap(op.Key)
            if err != nil {
                return fmt.Errorf("marshaling key: %w", err)
            }
            items = append(items, types.TransactWriteItem{
                Delete: &types.Delete{
                    TableName: aws.String(c.table),
                    Key:       key,
                },
            })

        case OpConditionCheck:
            key, err := attributevalue.MarshalMap(op.Key)
            if err != nil {
                return fmt.Errorf("marshaling key: %w", err)
            }
            items = append(items, types.TransactWriteItem{
                ConditionCheck: &types.ConditionCheck{
                    TableName:           aws.String(c.table),
                    Key:                 key,
                    ConditionExpression: op.Condition,
                },
            })
        }
    }

    _, err := c.client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
        TransactItems:      items,
        // Idempotency token prevents duplicate execution on retry
        ClientRequestToken: aws.String(generateRequestToken()),
    })

    if err != nil {
        var tce *types.TransactionCanceledException
        if errors.As(err, &tce) {
            return parseTransactionCancelReasons(tce)
        }
        return fmt.Errorf("transact write: %w", err)
    }

    return nil
}

// QueryGSI queries a Global Secondary Index with a filter.
func (c *DynamoClient) QueryGSI(
    ctx context.Context,
    indexName, pkName, pkValue string,
    filter *expression.ConditionBuilder,
    out interface{},
) error {
    keyExpr := expression.Key(pkName).Equal(expression.Value(pkValue))
    builder := expression.NewBuilder().WithKeyCondition(keyExpr)
    if filter != nil {
        builder = builder.WithFilter(*filter)
    }

    expr, err := builder.Build()
    if err != nil {
        return fmt.Errorf("building query expression: %w", err)
    }

    paginator := dynamodb.NewQueryPaginator(c.client, &dynamodb.QueryInput{
        TableName:                 aws.String(c.table),
        IndexName:                 aws.String(indexName),
        KeyConditionExpression:    expr.KeyCondition(),
        FilterExpression:          expr.Filter(),
        ExpressionAttributeNames:  expr.Names(),
        ExpressionAttributeValues: expr.Values(),
    })

    var allItems []map[string]types.AttributeValue

    for paginator.HasMorePages() {
        page, err := paginator.NextPage(ctx)
        if err != nil {
            return fmt.Errorf("querying GSI %s: %w", indexName, err)
        }
        allItems = append(allItems, page.Items...)
    }

    return attributevalue.UnmarshalListOfMaps(allItems, out)
}

// BatchGet retrieves multiple items by key in batches of 100.
func (c *DynamoClient) BatchGet(ctx context.Context, keys []map[string]string, out interface{}) error {
    const batchSize = 100
    var allItems []map[string]types.AttributeValue

    for i := 0; i < len(keys); i += batchSize {
        end := i + batchSize
        if end > len(keys) {
            end = len(keys)
        }
        batch := keys[i:end]

        requestKeys := make([]map[string]types.AttributeValue, len(batch))
        for j, k := range batch {
            av, err := attributevalue.MarshalMap(k)
            if err != nil {
                return err
            }
            requestKeys[j] = av
        }

        result, err := c.client.BatchGetItem(ctx, &dynamodb.BatchGetItemInput{
            RequestItems: map[string]types.KeysAndAttributes{
                c.table: {
                    Keys:           requestKeys,
                    ConsistentRead: aws.Bool(false), // Eventually consistent for batch
                },
            },
        })
        if err != nil {
            return fmt.Errorf("batch get: %w", err)
        }

        if items, ok := result.Responses[c.table]; ok {
            allItems = append(allItems, items...)
        }

        // Handle unprocessed keys (retry)
        // In production, implement retry loop for UnprocessedKeys
    }

    return attributevalue.UnmarshalListOfMaps(allItems, out)
}
```

## Secrets Manager Integration

```go
package secrets

import (
    "context"
    "encoding/json"
    "fmt"
    "sync"
    "time"

    "github.com/aws/aws-sdk-go-v2/aws"
    "github.com/aws/aws-sdk-go-v2/service/secretsmanager"
)

type SecretCache struct {
    mu        sync.RWMutex
    cache     map[string]cachedSecret
    client    *secretsmanager.Client
    ttl       time.Duration
}

type cachedSecret struct {
    value     string
    expiresAt time.Time
}

func NewSecretCache(cfg aws.Config, ttl time.Duration) *SecretCache {
    return &SecretCache{
        cache:  make(map[string]cachedSecret),
        client: secretsmanager.NewFromConfig(cfg),
        ttl:    ttl,
    }
}

// GetSecret retrieves a secret, using cache if available.
func (s *SecretCache) GetSecret(ctx context.Context, arn string) (string, error) {
    s.mu.RLock()
    if cached, ok := s.cache[arn]; ok && time.Now().Before(cached.expiresAt) {
        s.mu.RUnlock()
        return cached.value, nil
    }
    s.mu.RUnlock()

    // Fetch from AWS
    result, err := s.client.GetSecretValue(ctx, &secretsmanager.GetSecretValueInput{
        SecretId: aws.String(arn),
    })
    if err != nil {
        return "", fmt.Errorf("getting secret %s: %w", arn, err)
    }

    value := aws.ToString(result.SecretString)

    s.mu.Lock()
    s.cache[arn] = cachedSecret{
        value:     value,
        expiresAt: time.Now().Add(s.ttl),
    }
    s.mu.Unlock()

    return value, nil
}

// GetJSONSecret retrieves a secret and unmarshals it into the target struct.
func (s *SecretCache) GetJSONSecret(ctx context.Context, arn string, target interface{}) error {
    value, err := s.GetSecret(ctx, arn)
    if err != nil {
        return err
    }

    return json.Unmarshal([]byte(value), target)
}
```

## Testing with LocalStack

```go
// testing/localstack.go
package testing

import (
    "context"
    "fmt"
    "testing"

    "github.com/aws/aws-sdk-go-v2/aws"
    "github.com/aws/aws-sdk-go-v2/config"
    "github.com/aws/aws-sdk-go-v2/credentials"
    "github.com/aws/aws-sdk-go-v2/service/dynamodb"
    "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
    "github.com/aws/aws-sdk-go-v2/service/s3"
    "github.com/testcontainers/testcontainers-go"
    "github.com/testcontainers/testcontainers-go/modules/localstack"
)

type LocalStackSuite struct {
    container *localstack.LocalStackContainer
    cfg       aws.Config
}

func NewLocalStackSuite(ctx context.Context, t *testing.T) *LocalStackSuite {
    t.Helper()

    container, err := localstack.Run(ctx, "localstack/localstack:3.5")
    if err != nil {
        t.Fatalf("starting LocalStack: %v", err)
    }

    t.Cleanup(func() {
        if err := container.Terminate(ctx); err != nil {
            t.Logf("terminating LocalStack: %v", err)
        }
    })

    host, err := container.Host(ctx)
    if err != nil {
        t.Fatalf("getting LocalStack host: %v", err)
    }

    port, err := container.MappedPort(ctx, "4566/tcp")
    if err != nil {
        t.Fatalf("getting LocalStack port: %v", err)
    }

    endpoint := fmt.Sprintf("http://%s:%s", host, port.Port())

    cfg, err := config.LoadDefaultConfig(ctx,
        config.WithRegion("us-east-1"),
        config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(
            "test", "test", "test",
        )),
        config.WithEndpointResolverWithOptions(
            aws.EndpointResolverWithOptionsFunc(func(service, region string, options ...interface{}) (aws.Endpoint, error) {
                return aws.Endpoint{
                    URL:               endpoint,
                    HostnameImmutable: true,
                }, nil
            }),
        ),
    )
    if err != nil {
        t.Fatalf("creating AWS config: %v", err)
    }

    return &LocalStackSuite{container: container, cfg: cfg}
}

func (s *LocalStackSuite) Config() aws.Config {
    return s.cfg
}

// CreateTestTable creates a DynamoDB table for testing.
func (s *LocalStackSuite) CreateTestTable(ctx context.Context, t *testing.T, tableName string) {
    t.Helper()
    client := dynamodb.NewFromConfig(s.cfg)

    _, err := client.CreateTable(ctx, &dynamodb.CreateTableInput{
        TableName: aws.String(tableName),
        AttributeDefinitions: []types.AttributeDefinition{
            {AttributeName: aws.String("PK"), AttributeType: types.ScalarAttributeTypeS},
            {AttributeName: aws.String("SK"), AttributeType: types.ScalarAttributeTypeS},
        },
        KeySchema: []types.KeySchemaElement{
            {AttributeName: aws.String("PK"), KeyType: types.KeyTypeHash},
            {AttributeName: aws.String("SK"), KeyType: types.KeyTypeRange},
        },
        BillingMode: types.BillingModePayPerRequest,
    })
    if err != nil {
        t.Fatalf("creating test table: %v", err)
    }
}

// CreateTestBucket creates an S3 bucket for testing.
func (s *LocalStackSuite) CreateTestBucket(ctx context.Context, t *testing.T, bucketName string) {
    t.Helper()
    client := s3.NewFromConfig(s.cfg, func(o *s3.Options) {
        o.UsePathStyle = true // LocalStack requires path-style
    })

    _, err := client.CreateBucket(ctx, &s3.CreateBucketInput{
        Bucket: aws.String(bucketName),
    })
    if err != nil {
        t.Fatalf("creating test bucket: %v", err)
    }
}

// Integration test example
func TestDynamoOrderRepository(t *testing.T) {
    ctx := context.Background()
    suite := NewLocalStackSuite(ctx, t)
    suite.CreateTestTable(ctx, t, "orders")

    repo := NewOrderRepository(suite.Config(), "orders")

    t.Run("create and retrieve order", func(t *testing.T) {
        order := Order{
            PK:         "ORDER#123",
            SK:         "METADATA",
            CustomerID: "CUST#456",
            Amount:     99.95,
        }

        if err := repo.Create(ctx, order); err != nil {
            t.Fatalf("creating order: %v", err)
        }

        retrieved, err := repo.Get(ctx, "ORDER#123", "METADATA")
        if err != nil {
            t.Fatalf("getting order: %v", err)
        }

        if retrieved.Amount != order.Amount {
            t.Errorf("got amount %v, want %v", retrieved.Amount, order.Amount)
        }
    })
}
```

## Request Middleware: Logging and Tracing

```go
package middleware

import (
    "context"
    "fmt"
    "time"

    "github.com/aws/smithy-go/middleware"
    smithyhttp "github.com/aws/smithy-go/transport/http"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/trace"
)

var tracer = otel.Tracer("aws-sdk")

// TracingMiddleware adds OpenTelemetry spans to AWS SDK calls.
type TracingMiddleware struct{}

func (m *TracingMiddleware) ID() string { return "OpenTelemetryTracing" }

func (m *TracingMiddleware) HandleInitialize(
    ctx context.Context,
    in middleware.InitializeInput,
    next middleware.InitializeHandler,
) (middleware.InitializeOutput, middleware.Metadata, error) {
    service, operation := getServiceOperation(ctx)

    ctx, span := tracer.Start(ctx,
        fmt.Sprintf("aws.%s.%s", service, operation),
        trace.WithSpanKind(trace.SpanKindClient),
        trace.WithAttributes(
            attribute.String("aws.service", service),
            attribute.String("aws.operation", operation),
            attribute.String("rpc.system", "aws-api"),
            attribute.String("rpc.service", service),
            attribute.String("rpc.method", operation),
        ),
    )
    defer span.End()

    start := time.Now()
    out, meta, err := next.HandleInitialize(ctx, in)
    elapsed := time.Since(start)

    span.SetAttributes(attribute.Float64("aws.duration_ms", float64(elapsed.Milliseconds())))

    if err != nil {
        span.RecordError(err)
    }

    return out, meta, err
}

func AddTracingMiddleware(stack *middleware.Stack) error {
    return stack.Initialize.Add(&TracingMiddleware{}, middleware.After)
}

// Apply middleware when creating clients:
// s3.NewFromConfig(cfg, func(o *s3.Options) {
//     o.APIOptions = append(o.APIOptions, AddTracingMiddleware)
// })
```

## Summary

AWS SDK v2 patterns for production Go services:

- Use `config.LoadDefaultConfig` with IRSA for Kubernetes workloads - no static credentials in code or environment
- Configure `retry.NewStandard` with full jitter backoff and custom retryable error codes
- Share a single `aws.Config` and `http.Client` across all service clients to pool connections
- Use `manager.Uploader` and `manager.Downloader` for S3 objects over 5 MiB (multipart automatically)
- DynamoDB transactions (up to 100 items) provide atomicity; parse `TransactionCanceledException` reasons for meaningful error messages
- Cache Secrets Manager responses with TTL to avoid repeated API calls and rate limits
- Test with LocalStack via testcontainers to run integration tests without AWS accounts
- Add SDK middleware for tracing all AWS calls without modifying business logic
