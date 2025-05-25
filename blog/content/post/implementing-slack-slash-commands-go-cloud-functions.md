---
title: "Implementing Slack Slash Commands with Go and Google Cloud Functions"
date: 2026-09-03T09:00:00-05:00
draft: false
tags: ["Go", "Slack", "Serverless", "Google Cloud", "Cloud Functions", "Integration"]
categories:
- Go
- Serverless
- Integration
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to building, deploying, and securing Slack Slash Commands using Go and Google Cloud Functions"
more_link: "yes"
url: "/implementing-slack-slash-commands-go-cloud-functions/"
---

Slack Slash Commands offer a powerful way to extend your workspace with custom functionality. In this guide, we'll implement a robust, secure Slash Command handler using Go and Google Cloud Functions to create a serverless integration that's both cost-effective and scalable.

<!--more-->

# Implementing Slack Slash Commands with Go and Google Cloud Functions

## Why Serverless for Slack Commands?

Slack Slash Commands are an ideal use case for serverless architecture:

1. **Sporadic Usage**: Commands are typically invoked intermittently, making serverless "pay-for-what-you-use" pricing efficient
2. **Low Latency Requirements**: Cloud Functions provide near-instant scaling for responsive command execution
3. **Simplified Operations**: No server management overhead or continuous runtime costs
4. **Security Isolation**: Each function operates in its own environment, minimizing potential attack surface

Google Cloud Functions provide an excellent platform for these requirements with minimal configuration and maintenance.

## Setting Up Your Environment

### Prerequisites

Before diving into implementation, ensure you have:

- A Google Cloud Platform (GCP) account with billing enabled
- The `gcloud` CLI tool installed and configured
- Go development environment (Go 1.19+)
- A Slack workspace with permission to create applications

### Creating a Cloud Function

First, we need to create a new HTTP-triggered Cloud Function:

1. Navigate to **Cloud Functions** in the Google Cloud Console
2. Click **Create Function**
3. Configure the basics:
   - **Environment**: 2nd gen
   - **Function name**: `slack-command-handler`
   - **Region**: Select a region close to your users
   - **Runtime**: Go 1.19 (or newer)
   - **Entry point**: `HandleSlackCommand` (the function we'll implement)

4. For HTTP settings:
   - **Authentication**: Allow unauthenticated invocations
   - **Require HTTPS**: Enabled (required for Slack)

5. Note the **Trigger URL** after creation - we'll need this for Slack configuration

## Creating Your Slack Application

Next, we'll create a Slack application and configure a Slash Command:

1. Visit the [Slack API portal](https://api.slack.com/apps) and click **Create New App**
2. Choose **From scratch**
3. Provide an **App Name** and select your **Workspace**
4. Under **Features** in the sidebar, select **Slash Commands**
5. Click **Create New Command** and configure:
   - **Command**: The slash command (e.g., `/tools`)
   - **Request URL**: The Cloud Function trigger URL from earlier
   - **Short Description**: Brief explanation of what the command does
   - **Usage Hint**: Optional format guidance (e.g., `/tools [action] [parameters]`)
6. Click **Save**

7. Under **Basic Information**, copy the **Signing Secret** - we'll use this to verify requests

8. Install the app to your workspace by navigating to **Install App** and clicking **Install to Workspace**

## Implementing the Command Handler

Now let's implement our Go function to handle Slack commands securely. Create a new Go module:

```bash
mkdir slack-command-handler
cd slack-command-handler
go mod init github.com/yourusername/slack-command-handler
```

### Project Structure

We'll use a clean structure:

```
slack-command-handler/
├── cmd/
│   └── function.go    # Cloud Function entry point
├── internal/
│   ├── handler/
│   │   └── handler.go # Command processing logic
│   ├── slack/
│   │   └── verify.go  # Slack signature verification
│   └── commands/
│       └── commands.go # Individual command implementations
├── go.mod
└── go.sum
```

### Step 1: Implement Request Verification

First, let's create the verification logic to ensure requests actually come from Slack:

```go
// internal/slack/verify.go
package slack

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/ioutil"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	// SlackSignatureHeader is the header name for the Slack signature
	SlackSignatureHeader = "X-Slack-Signature"
	
	// SlackRequestTimestampHeader is the header name for the request timestamp
	SlackRequestTimestampHeader = "X-Slack-Request-Timestamp"
	
	// MaxRequestAge is the maximum age of a request in seconds
	MaxRequestAge = 300 // 5 minutes
)

var (
	ErrMissingSignature   = errors.New("missing Slack signature header")
	ErrMissingTimestamp   = errors.New("missing timestamp header")
	ErrInvalidTimestamp   = errors.New("invalid timestamp format")
	ErrRequestTooOld      = errors.New("request timestamp too old")
	ErrInvalidSignature   = errors.New("invalid request signature")
	ErrSigningSecretEmpty = errors.New("slack signing secret not configured")
)

// VerifyRequest validates that a request actually came from Slack
func VerifyRequest(r *http.Request) error {
	// Get signing secret from environment
	signingSecret := os.Getenv("SLACK_SIGNING_SECRET")
	if signingSecret == "" {
		return ErrSigningSecretEmpty
	}

	// Get Slack signature from header
	signature := r.Header.Get(SlackSignatureHeader)
	if signature == "" {
		return ErrMissingSignature
	}

	// Get request timestamp
	ts := r.Header.Get(SlackRequestTimestampHeader)
	if ts == "" {
		return ErrMissingTimestamp
	}

	// Parse timestamp
	tsInt, err := strconv.ParseInt(ts, 10, 64)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidTimestamp, err)
	}

	// Check if request is too old (replay attack protection)
	now := time.Now().Unix()
	if now-tsInt > MaxRequestAge {
		return ErrRequestTooOld
	}

	// Read body
	body, err := ioutil.ReadAll(r.Body)
	if err != nil {
		return fmt.Errorf("failed to read request body: %w", err)
	}
	
	// Important: Restore the body for further processing
	r.Body = ioutil.NopCloser(strings.NewReader(string(body)))

	// Create signature base string
	baseString := fmt.Sprintf("v0:%s:%s", ts, string(body))

	// Create HMAC signature
	h := hmac.New(sha256.New, []byte(signingSecret))
	h.Write([]byte(baseString))
	calculatedSignature := "v0=" + hex.EncodeToString(h.Sum(nil))

	// Verify signature with constant time comparison to prevent timing attacks
	if !hmac.Equal([]byte(signature), []byte(calculatedSignature)) {
		return ErrInvalidSignature
	}

	return nil
}
```

### Step 2: Implement Command Handler

Next, we'll implement the core handler logic:

```go
// internal/handler/handler.go
package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/yourusername/slack-command-handler/internal/commands"
	"github.com/yourusername/slack-command-handler/internal/slack"
)

// SlackResponse represents a formatted response to Slack
type SlackResponse struct {
	ResponseType string `json:"response_type,omitempty"` // "in_channel" or "ephemeral"
	Text         string `json:"text,omitempty"`
	Blocks       []any  `json:"blocks,omitempty"`
}

// HandleSlackCommand processes an incoming slash command from Slack
func HandleSlackCommand(w http.ResponseWriter, r *http.Request) {
	// Only allow POST requests
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Verify request is from Slack
	if err := slack.VerifyRequest(r); err != nil {
		fmt.Printf("Request verification failed: %v\n", err)
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	// Parse the form data
	if err := r.ParseForm(); err != nil {
		http.Error(w, "Error parsing form data", http.StatusBadRequest)
		return
	}

	// Extract command data
	command := r.FormValue("command")
	text := r.FormValue("text")
	userID := r.FormValue("user_id")
	channelID := r.FormValue("channel_id")
	
	// Log command usage (helpful for monitoring)
	fmt.Printf("Command executed: %s %s by user %s in channel %s\n", 
		command, text, userID, channelID)

	// Process the command
	response, err := processCommand(command, text, userID, channelID)
	if err != nil {
		fmt.Printf("Error processing command: %v\n", err)
		sendErrorResponse(w, "Sorry, there was an error processing your command")
		return
	}

	// Send the response
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

// processCommand routes commands to the appropriate handler
func processCommand(command, text, userID, channelID string) (*SlackResponse, error) {
	// Parse arguments
	args := parseArgs(text)
	
	// Route to appropriate command handler
	switch command {
	case "/tools":
		return commands.HandleToolsCommand(args, userID, channelID)
	default:
		return &SlackResponse{
			ResponseType: "ephemeral",
			Text:         fmt.Sprintf("Unrecognized command: %s", command),
		}, nil
	}
}

// parseArgs splits command text into arguments, respecting quoted strings
func parseArgs(text string) []string {
	if text == "" {
		return []string{}
	}
	
	// Basic splitting for now - can be enhanced for quoted arguments
	return strings.Fields(text)
}

// sendErrorResponse sends a formatted error message
func sendErrorResponse(w http.ResponseWriter, message string) {
	response := SlackResponse{
		ResponseType: "ephemeral",
		Text:         message,
	}
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}
```

### Step 3: Implement Command Logic

Now we'll implement specific command functionality:

```go
// internal/commands/commands.go
package commands

import (
	"fmt"
	"strings"
	"time"
)

// SlackResponse represents a formatted response to Slack
type SlackResponse struct {
	ResponseType string `json:"response_type,omitempty"` // "in_channel" or "ephemeral"
	Text         string `json:"text,omitempty"`
	Blocks       []any  `json:"blocks,omitempty"`
}

// HandleToolsCommand processes the /tools command
func HandleToolsCommand(args []string, userID, channelID string) (*SlackResponse, error) {
	// If no arguments provided, show help
	if len(args) == 0 {
		return showHelp(), nil
	}

	// Process subcommands
	switch args[0] {
	case "help":
		return showHelp(), nil
	case "time":
		return showCurrentTime(), nil
	case "echo":
		return echoMessage(args[1:]), nil
	default:
		return &SlackResponse{
			ResponseType: "ephemeral",
			Text:         fmt.Sprintf("Unknown subcommand: %s\nType `/tools help` for available commands.", args[0]),
		}, nil
	}
}

// showHelp displays available commands
func showHelp() *SlackResponse {
	helpText := `*Available commands:*
• \`/tools help\` - Show this help message
• \`/tools time\` - Show current server time
• \`/tools echo [message]\` - Echo back your message`

	return &SlackResponse{
		ResponseType: "ephemeral",
		Text:         helpText,
	}
}

// showCurrentTime returns the current server time
func showCurrentTime() *SlackResponse {
	now := time.Now()
	return &SlackResponse{
		ResponseType: "ephemeral",
		Text:         fmt.Sprintf("Current server time is: %s", now.Format(time.RFC1123)),
	}
}

// echoMessage echoes the provided message back to the user
func echoMessage(args []string) *SlackResponse {
	if len(args) == 0 {
		return &SlackResponse{
			ResponseType: "ephemeral",
			Text:         "Please provide a message to echo.",
		}
	}

	message := strings.Join(args, " ")
	return &SlackResponse{
		// Using in_channel makes the response visible to everyone
		ResponseType: "in_channel",
		Text:         fmt.Sprintf("Echo: %s", message),
	}
}
```

### Step 4: Cloud Function Entry Point

Finally, we need the main function entry point:

```go
// cmd/function.go
package cmd

import (
	"net/http"

	"github.com/yourusername/slack-command-handler/internal/handler"
)

// HandleSlackCommand is the Cloud Function entry point
func HandleSlackCommand(w http.ResponseWriter, r *http.Request) {
	handler.HandleSlackCommand(w, r)
}
```

## Deploying to Google Cloud Functions

Now that we have our implementation, let's prepare for deployment:

1. Create a `go.mod` file at the project root:

```go
module github.com/yourusername/slack-command-handler

go 1.19
```

2. Deploy using gcloud CLI:

```bash
gcloud functions deploy slack-command-handler \
  --gen2 \
  --runtime=go119 \
  --region=us-central1 \
  --source=. \
  --entry-point=HandleSlackCommand \
  --trigger-http \
  --allow-unauthenticated \
  --set-env-vars SLACK_SIGNING_SECRET=your_signing_secret_here
```

> **Security Note**: For production, use Secret Manager to store your signing secret rather than environment variables.

## Advanced Patterns for Production Use

### 1. Enhanced Security

For production environments, consider these additional security measures:

```go
// Set strict security headers
w.Header().Set("X-Content-Type-Options", "nosniff")
w.Header().Set("X-Frame-Options", "DENY")
w.Header().Set("Content-Security-Policy", "default-src 'none'")

// Use Secret Manager instead of environment variables
secretClient, err := secretmanager.NewClient(ctx)
if err != nil {
    log.Fatalf("Failed to create Secret Manager client: %v", err)
}

// Access the secret
secretResp, err := secretClient.AccessSecretVersion(ctx, &secretmanagerpb.AccessSecretVersionRequest{
    Name: "projects/your-project/secrets/slack-signing-secret/versions/latest",
})
```

### 2. Structured Logging

Implement structured logging for better observability:

```go
type LogEntry struct {
    Severity  string `json:"severity"`
    Message   string `json:"message"`
    Command   string `json:"command,omitempty"`
    User      string `json:"user,omitempty"`
    Channel   string `json:"channel,omitempty"`
    Timestamp string `json:"timestamp"`
}

func logInfo(message, command, user, channel string) {
    entry := LogEntry{
        Severity:  "INFO",
        Message:   message,
        Command:   command,
        User:      user,
        Channel:   channel,
        Timestamp: time.Now().Format(time.RFC3339),
    }
    
    entryJSON, _ := json.Marshal(entry)
    fmt.Println(string(entryJSON))
}
```

### 3. Interactive Responses

You can enhance your responses with interactive elements:

```go
// Block Kit message with interactive components
blocks := []map[string]interface{}{
    {
        "type": "section",
        "text": map[string]interface{}{
            "type": "mrkdwn",
            "text": "Please select an option:",
        },
    },
    {
        "type": "actions",
        "elements": []map[string]interface{}{
            {
                "type": "button",
                "text": map[string]interface{}{
                    "type": "plain_text",
                    "text": "Option 1",
                },
                "value": "option_1",
                "action_id": "button_1",
            },
            {
                "type": "button",
                "text": map[string]interface{}{
                    "type": "plain_text",
                    "text": "Option 2",
                },
                "value": "option_2",
                "action_id": "button_2",
            },
        },
    },
}

return &SlackResponse{
    ResponseType: "ephemeral",
    Blocks:       blocks,
}
```

### 4. Rate Limiting with Redis

For high-traffic commands, implement rate limiting:

```go
func checkRateLimit(userID string) error {
    ctx := context.Background()
    client, err := redis.NewClient(&redis.Options{
        Addr: os.Getenv("REDIS_ADDR"),
    })
    if err != nil {
        return fmt.Errorf("failed to connect to Redis: %w", err)
    }
    defer client.Close()
    
    key := fmt.Sprintf("rate_limit:%s", userID)
    count, err := client.Incr(ctx, key).Result()
    if err != nil {
        return fmt.Errorf("rate limit check failed: %w", err)
    }
    
    // First request sets expiration
    if count == 1 {
        client.Expire(ctx, key, time.Minute)
    }
    
    if count > 5 {
        return errors.New("rate limit exceeded")
    }
    
    return nil
}
```

## Real-World Use Cases

### 1. Kubernetes Status Checker

Implement a command to check the status of Kubernetes resources:

```go
func handleK8sStatus(args []string) (*SlackResponse, error) {
    if len(args) < 1 {
        return &SlackResponse{
            ResponseType: "ephemeral",
            Text: "Usage: `/tools k8s [namespace]`",
        }, nil
    }
    
    namespace := args[0]
    
    // Use the Kubernetes Go client to fetch pod status
    config, err := rest.InClusterConfig()
    if err != nil {
        return nil, fmt.Errorf("failed to get cluster config: %w", err)
    }
    
    clientset, err := kubernetes.NewForConfig(config)
    if err != nil {
        return nil, fmt.Errorf("failed to create clientset: %w", err)
    }
    
    pods, err := clientset.CoreV1().Pods(namespace).List(context.Background(), metav1.ListOptions{})
    if err != nil {
        return nil, fmt.Errorf("failed to list pods: %w", err)
    }
    
    // Format pod status as text
    var statusText strings.Builder
    statusText.WriteString(fmt.Sprintf("*Pods in %s namespace:*\n", namespace))
    
    for _, pod := range pods.Items {
        statusText.WriteString(fmt.Sprintf("• %s: %s\n", pod.Name, pod.Status.Phase))
    }
    
    return &SlackResponse{
        ResponseType: "ephemeral",
        Text: statusText.String(),
    }, nil
}
```

### 2. Automated On-Call Rotation

Implement a command to check or update on-call schedules:

```go
func handleOncall(args []string) (*SlackResponse, error) {
    if len(args) < 1 {
        return getCurrentOncall()
    }
    
    switch args[0] {
    case "current":
        return getCurrentOncall()
    case "next":
        return getNextOncall()
    case "override":
        if len(args) < 2 {
            return &SlackResponse{
                ResponseType: "ephemeral",
                Text: "Usage: `/tools oncall override @username`",
            }, nil
        }
        return setOncallOverride(args[1])
    default:
        return &SlackResponse{
            ResponseType: "ephemeral",
            Text: "Unknown oncall command. Use `current`, `next`, or `override`.",
        }, nil
    }
}
```

## Monitoring and Observability

To ensure reliable operation, implement proper monitoring:

1. Set up Cloud Monitoring with alerting on:
   - Error rates
   - Function execution time
   - Function invocation count

2. Add custom metrics for business logic:
   ```go
   // Record command usage metrics
   metricClient, err := monitoring.NewMetricClient(ctx)
   if err != nil {
       log.Printf("Failed to create monitoring client: %v", err)
   } else {
       err = metricClient.CreateTimeSeries(ctx, &monitoringpb.CreateTimeSeriesRequest{
           Name: "projects/" + projectID,
           TimeSeries: []*monitoringpb.TimeSeries{
               {
                   Metric: &metricpb.Metric{
                       Type: "custom.googleapis.com/slack/command_usage",
                       Labels: map[string]string{
                           "command": command,
                       },
                   },
                   Points: []*monitoringpb.Point{
                       {
                           Interval: &monitoringpb.TimeInterval{
                               EndTime: &timestamppb.Timestamp{
                                   Seconds: time.Now().Unix(),
                               },
                           },
                           Value: &monitoringpb.TypedValue{
                               Value: &monitoringpb.TypedValue_Int64Value{
                                   Int64Value: 1,
                               },
                           },
                       },
                   },
               },
           },
       })
       if err != nil {
           log.Printf("Failed to write metrics: %v", err)
       }
   }
   ```

## Conclusion

Implementing Slack Slash Commands with Go and Google Cloud Functions provides a powerful, cost-effective way to extend your team's Slack workspace with custom functionality. The serverless architecture ensures your commands scale automatically with usage while minimizing operational overhead.

By following the security best practices outlined in this guide, your command handler will safely authenticate requests from Slack and protect against common attack vectors. The modular design allows for easy extension as your command needs grow more complex.

For teams already using Google Cloud, this approach leverages your existing infrastructure while providing a clean separation between your Slack integration and other systems. The result is a robust, maintainable command handler that enhances team productivity without significant operational burden.

Remember to consistently monitor your function's performance and cost to ensure it continues to meet your needs as usage patterns evolve.