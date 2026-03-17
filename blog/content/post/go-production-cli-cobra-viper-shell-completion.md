---
title: "Building Production-Ready CLI Tools in Go: Cobra, Viper, and Shell Completion"
date: 2031-06-29T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "CLI", "Cobra", "Viper", "DevTools"]
categories: ["Go", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete guide to building enterprise-grade CLI tools in Go using Cobra for command structure, Viper for layered configuration management, and generating shell completions for bash, zsh, and fish."
more_link: "yes"
url: "/go-production-cli-cobra-viper-shell-completion/"
---

CLI tools are the backbone of DevOps automation. The difference between a throwaway script and a production-grade tool comes down to consistent configuration management, predictable behavior across environments, and the small quality-of-life features like shell completion that determine whether engineers actually use the tool. This post builds a complete, production-ready CLI from scratch using Cobra and Viper, covering patterns that hold up in enterprise environments.

<!--more-->

# Building Production-Ready CLI Tools in Go: Cobra, Viper, and Shell Completion

## Project Structure

Start with a clean module structure that scales to dozens of subcommands without becoming unmaintainable.

```
k8stool/
├── cmd/
│   ├── root.go          # Root command, global flags, Viper init
│   ├── deploy.go        # deploy subcommand
│   ├── deploy_app.go    # deploy app subcommand
│   ├── deploy_db.go     # deploy db subcommand
│   ├── status.go        # status subcommand
│   ├── completion.go    # shell completion subcommand
│   └── version.go       # version subcommand
├── internal/
│   ├── config/
│   │   ├── config.go    # Config struct and defaults
│   │   └── validate.go  # Config validation
│   ├── client/
│   │   └── client.go    # API client
│   └── output/
│       └── output.go    # Table, JSON, YAML output formatters
├── main.go
├── go.mod
└── go.sum
```

```bash
go mod init github.com/myorg/k8stool
go get github.com/spf13/cobra@latest
go get github.com/spf13/viper@latest
go get github.com/spf13/pflag@latest
go get go.uber.org/zap@latest
go get github.com/olekukonko/tablewriter@latest
```

## main.go: The Entry Point

Keep `main.go` minimal. Its only job is to call the root command's Execute function and handle the top-level exit code.

```go
// main.go
package main

import (
	"os"

	"github.com/myorg/k8stool/cmd"
)

// These variables are set by the linker at build time via -ldflags
var (
	version   = "dev"
	commit    = "none"
	buildDate = "unknown"
	builtBy   = "unknown"
)

func main() {
	cmd.SetVersionInfo(version, commit, buildDate, builtBy)

	if err := cmd.Execute(); err != nil {
		// Cobra already printed the error; just set the exit code
		os.Exit(1)
	}
}
```

Build with version information injected at link time:

```bash
VERSION=$(git describe --tags --always --dirty)
COMMIT=$(git rev-parse --short HEAD)
BUILD_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

go build -ldflags "-X main.version=${VERSION} \
  -X main.commit=${COMMIT} \
  -X main.buildDate=${BUILD_DATE} \
  -X main.builtBy=$(whoami)" \
  -o k8stool .
```

## Root Command and Global Configuration

The root command sets up global flags, initializes Viper, and configures the logger before any subcommand runs.

```go
// cmd/root.go
package cmd

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/myorg/k8stool/internal/config"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

var (
	cfgFile string
	logger  *zap.Logger
	cfg     *config.Config
)

var rootCmd = &cobra.Command{
	Use:   "k8stool",
	Short: "Enterprise Kubernetes deployment and management tool",
	Long: `k8stool provides a unified interface for deploying and managing
applications in Kubernetes clusters across multiple environments.

Configuration is loaded from the following sources in order of precedence:
  1. Command-line flags
  2. Environment variables (K8STOOL_*)
  3. Config file (~/.k8stool/config.yaml or --config flag)
  4. Built-in defaults

Run 'k8stool --help' for a list of available commands.`,
	// PersistentPreRunE runs before every subcommand
	PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
		return initLogger()
	},
	// SilenceErrors prevents double-printing of errors
	SilenceErrors: true,
	// SilenceUsage prevents printing usage on every error
	SilenceUsage: true,
}

func Execute() error {
	return rootCmd.Execute()
}

func init() {
	cobra.OnInitialize(initConfig)

	// Global flags that apply to all subcommands
	rootCmd.PersistentFlags().StringVar(&cfgFile, "config", "",
		"config file (default: ~/.k8stool/config.yaml)")
	rootCmd.PersistentFlags().String("context", "",
		"Kubernetes context to use (overrides kubeconfig current-context)")
	rootCmd.PersistentFlags().String("namespace", "default",
		"Kubernetes namespace")
	rootCmd.PersistentFlags().String("output", "table",
		"Output format: table|json|yaml|wide")
	rootCmd.PersistentFlags().Bool("debug", false,
		"Enable debug logging")
	rootCmd.PersistentFlags().Bool("no-color", false,
		"Disable color output")
	rootCmd.PersistentFlags().Int("timeout", 300,
		"Operation timeout in seconds")

	// Bind all flags to Viper so they participate in the precedence chain
	viper.BindPFlag("context", rootCmd.PersistentFlags().Lookup("context"))
	viper.BindPFlag("namespace", rootCmd.PersistentFlags().Lookup("namespace"))
	viper.BindPFlag("output", rootCmd.PersistentFlags().Lookup("output"))
	viper.BindPFlag("debug", rootCmd.PersistentFlags().Lookup("debug"))
	viper.BindPFlag("no_color", rootCmd.PersistentFlags().Lookup("no-color"))
	viper.BindPFlag("timeout", rootCmd.PersistentFlags().Lookup("timeout"))
}

func initConfig() {
	if cfgFile != "" {
		viper.SetConfigFile(cfgFile)
	} else {
		home, err := os.UserHomeDir()
		cobra.CheckErr(err)

		// Look for config in ~/.k8stool/ directory
		viper.AddConfigPath(filepath.Join(home, ".k8stool"))
		// Also look in current directory for project-level overrides
		viper.AddConfigPath(".")
		viper.SetConfigName("config")
		viper.SetConfigType("yaml")
	}

	// Environment variable configuration
	// K8STOOL_CONTEXT, K8STOOL_NAMESPACE, K8STOOL_DEBUG, etc.
	viper.SetEnvPrefix("K8STOOL")
	viper.AutomaticEnv()
	// Replace hyphens with underscores in env var names
	viper.SetEnvKeyReplacer(strings.NewReplacer("-", "_", ".", "_"))

	// Set defaults (lowest priority)
	viper.SetDefault("output", "table")
	viper.SetDefault("namespace", "default")
	viper.SetDefault("timeout", 300)
	viper.SetDefault("debug", false)
	viper.SetDefault("no_color", false)
	viper.SetDefault("api.base_url", "https://api.example.com")
	viper.SetDefault("api.retry_count", 3)
	viper.SetDefault("api.retry_delay_ms", 500)

	if err := viper.ReadInConfig(); err != nil {
		// It's fine if no config file exists; we use defaults and env vars
		if _, ok := err.(viper.ConfigFileNotFoundError); !ok {
			fmt.Fprintf(os.Stderr, "Error reading config file: %v\n", err)
			os.Exit(1)
		}
	}

	// Unmarshal into typed config struct for use by subcommands
	cfg = &config.Config{}
	if err := viper.Unmarshal(cfg); err != nil {
		fmt.Fprintf(os.Stderr, "Error parsing config: %v\n", err)
		os.Exit(1)
	}
}

func initLogger() error {
	level := zapcore.InfoLevel
	if viper.GetBool("debug") {
		level = zapcore.DebugLevel
	}

	zapCfg := zap.NewProductionConfig()
	zapCfg.Level = zap.NewAtomicLevelAt(level)
	// Use console encoding for CLI tools (human-readable)
	zapCfg.Encoding = "console"
	zapCfg.EncoderConfig.EncodeTime = zapcore.ISO8601TimeEncoder
	zapCfg.EncoderConfig.EncodeLevel = zapcore.CapitalColorLevelEncoder

	var err error
	logger, err = zapCfg.Build()
	if err != nil {
		return fmt.Errorf("failed to initialize logger: %w", err)
	}

	return nil
}
```

## Configuration Struct with Validation

Using a typed struct rather than raw `viper.Get()` calls prevents typo-related bugs and enables compile-time type checking.

```go
// internal/config/config.go
package config

import (
	"fmt"
	"os"
	"time"
)

// Config is the top-level configuration structure. All fields correspond to
// Viper keys using the mapstructure tags.
type Config struct {
	// Connection
	Context   string `mapstructure:"context"`
	Namespace string `mapstructure:"namespace"`
	KubeConfig string `mapstructure:"kubeconfig"`

	// Display
	Output  string `mapstructure:"output"`
	NoColor bool   `mapstructure:"no_color"`

	// Behavior
	Debug   bool          `mapstructure:"debug"`
	Timeout time.Duration `mapstructure:"timeout"`

	// API
	API APIConfig `mapstructure:"api"`

	// Registry
	Registry RegistryConfig `mapstructure:"registry"`

	// Environments
	Environments map[string]EnvironmentConfig `mapstructure:"environments"`
}

type APIConfig struct {
	BaseURL      string        `mapstructure:"base_url"`
	RetryCount   int           `mapstructure:"retry_count"`
	RetryDelay   time.Duration `mapstructure:"retry_delay_ms"`
	Timeout      time.Duration `mapstructure:"timeout_seconds"`
}

type RegistryConfig struct {
	URL      string `mapstructure:"url"`
	Username string `mapstructure:"username"`
	// Password is deliberately not stored in the config file.
	// Use K8STOOL_REGISTRY_PASSWORD env var or a credential helper.
}

type EnvironmentConfig struct {
	ClusterURL  string            `mapstructure:"cluster_url"`
	Namespace   string            `mapstructure:"namespace"`
	Labels      map[string]string `mapstructure:"labels"`
}

// Validate performs semantic validation of the config beyond what Viper handles.
func (c *Config) Validate() error {
	validOutputs := map[string]bool{
		"table": true, "json": true, "yaml": true, "wide": true,
	}
	if !validOutputs[c.Output] {
		return fmt.Errorf("invalid output format %q: must be one of table, json, yaml, wide", c.Output)
	}

	if c.Timeout <= 0 {
		return fmt.Errorf("timeout must be positive, got %v", c.Timeout)
	}

	if c.API.RetryCount < 0 || c.API.RetryCount > 10 {
		return fmt.Errorf("api.retry_count must be between 0 and 10, got %d", c.API.RetryCount)
	}

	return nil
}
```

A sample configuration file that users place at `~/.k8stool/config.yaml`:

```yaml
# ~/.k8stool/config.yaml
context: "prod-cluster"
namespace: "production"
output: "table"
debug: false
timeout: 600

api:
  base_url: "https://api.mycompany.com"
  retry_count: 3
  retry_delay_ms: 500ms
  timeout_seconds: 30s

registry:
  url: "registry.mycompany.com"
  username: "ci-bot"
  # Password via: export K8STOOL_REGISTRY_PASSWORD="..."

environments:
  dev:
    cluster_url: "https://dev-k8s.mycompany.com"
    namespace: "dev"
    labels:
      env: dev
      tier: application
  prod:
    cluster_url: "https://prod-k8s.mycompany.com"
    namespace: "production"
    labels:
      env: prod
      tier: application
```

## Subcommand with Nested Commands

The `deploy` command demonstrates the pattern for subcommand groups with shared flag inheritance.

```go
// cmd/deploy.go
package cmd

import (
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
)

var deployCmd = &cobra.Command{
	Use:   "deploy",
	Short: "Deploy applications and infrastructure components",
	Long: `Deploy manages the lifecycle of application and database deployments.

Examples:
  # Deploy an application to the dev environment
  k8stool deploy app my-service --env dev --image v1.2.3

  # Deploy with dry-run to preview changes
  k8stool deploy app my-service --env prod --image v1.2.3 --dry-run

  # Deploy a database and wait for it to be ready
  k8stool deploy db postgres --env staging --wait`,
	// Prevent running 'deploy' without a subcommand
	RunE: func(cmd *cobra.Command, args []string) error {
		return cmd.Help()
	},
}

func init() {
	rootCmd.AddCommand(deployCmd)

	// Flags shared by all deploy subcommands
	deployCmd.PersistentFlags().String("env", "",
		"Target environment (dev|staging|prod)")
	deployCmd.PersistentFlags().Bool("dry-run", false,
		"Preview changes without applying them")
	deployCmd.PersistentFlags().Bool("wait", false,
		"Wait for deployment to complete before returning")
	deployCmd.PersistentFlags().Int("wait-timeout", 600,
		"Seconds to wait for deployment completion")

	viper.BindPFlag("deploy.env", deployCmd.PersistentFlags().Lookup("env"))
	viper.BindPFlag("deploy.dry_run", deployCmd.PersistentFlags().Lookup("dry-run"))
	viper.BindPFlag("deploy.wait", deployCmd.PersistentFlags().Lookup("wait"))
}
```

```go
// cmd/deploy_app.go
package cmd

import (
	"context"
	"fmt"
	"time"

	"github.com/myorg/k8stool/internal/client"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
)

var deployAppCmd = &cobra.Command{
	Use:   "app [service-name]",
	Short: "Deploy an application service",
	Long: `Deploy an application service to the target environment.

The service name must match an entry in your team's service registry.
Image tags follow semantic versioning (e.g., v1.2.3) or may be a
git SHA for development deployments.`,
	Args: cobra.ExactArgs(1),
	ValidArgsFunction: func(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
		// Dynamic completion: fetch service names from API
		if len(args) != 0 {
			return nil, cobra.ShellCompDirectiveNoFileComp
		}
		services, err := fetchServiceNames(toComplete)
		if err != nil {
			return nil, cobra.ShellCompDirectiveError
		}
		return services, cobra.ShellCompDirectiveNoFileComp
	},
	RunE: runDeployApp,
}

func init() {
	deployCmd.AddCommand(deployAppCmd)

	deployAppCmd.Flags().String("image", "",
		"Container image tag to deploy (required)")
	deployAppCmd.Flags().String("replicas", "",
		"Override replica count (empty = use environment default)")
	deployAppCmd.Flags().StringSlice("set", nil,
		"Override Helm values (format: key=value, may be specified multiple times)")
	deployAppCmd.Flags().Bool("force", false,
		"Force deployment even if the image tag is already deployed")

	deployAppCmd.MarkFlagRequired("image")

	viper.BindPFlag("deploy.image", deployAppCmd.Flags().Lookup("image"))
}

func runDeployApp(cmd *cobra.Command, args []string) error {
	serviceName := args[0]
	env := viper.GetString("deploy.env")
	image := viper.GetString("deploy.image")
	dryRun := viper.GetBool("deploy.dry_run")
	wait := viper.GetBool("deploy.wait")
	waitTimeout := viper.GetInt("wait-timeout")

	if env == "" {
		return fmt.Errorf("--env is required for deploy operations")
	}

	logger.Sugar().Infof("Deploying %s:%s to %s", serviceName, image, env)

	// Build deployment request
	req := &client.DeployRequest{
		ServiceName: serviceName,
		Image:       image,
		Environment: env,
		DryRun:      dryRun,
	}

	if overrides, _ := cmd.Flags().GetStringSlice("set"); len(overrides) > 0 {
		req.HelmOverrides = overrides
	}

	ctx := context.Background()
	if wait {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, time.Duration(waitTimeout)*time.Second)
		defer cancel()
	}

	c := client.New(cfg)
	result, err := c.Deploy(ctx, req)
	if err != nil {
		return fmt.Errorf("deployment failed: %w", err)
	}

	if dryRun {
		fmt.Println("DRY RUN - the following changes would be applied:")
	}

	return renderOutput(result, viper.GetString("output"))
}

// fetchServiceNames is called by the shell completion function.
// Returns service names matching the prefix for tab completion.
func fetchServiceNames(prefix string) ([]string, error) {
	// In a real implementation, this would call your service registry API
	// with the prefix for efficient server-side filtering.
	return []string{"api-gateway", "auth-service", "user-service", "payment-service"}, nil
}
```

## Shell Completion

Shell completion is what separates professional CLI tools from scripts. Cobra generates completion scripts for bash, zsh, fish, and PowerShell.

```go
// cmd/completion.go
package cmd

import (
	"os"

	"github.com/spf13/cobra"
)

var completionCmd = &cobra.Command{
	Use:   "completion [bash|zsh|fish|powershell]",
	Short: "Generate shell completion scripts",
	Long: `Generate shell completion scripts for k8stool.

To load completions:

Bash:
  # Linux
  k8stool completion bash > /etc/bash_completion.d/k8stool

  # macOS (Homebrew)
  k8stool completion bash > $(brew --prefix)/etc/bash_completion.d/k8stool

Zsh:
  # If shell completion is not already enabled in your environment,
  # you will need to enable it:
  echo "autoload -U compinit; compinit" >> ~/.zshrc

  k8stool completion zsh > "${fpath[1]}/_k8stool"

  # Start a new shell for this setup to take effect.

Fish:
  k8stool completion fish | source

  # To load completions for each session, execute once:
  k8stool completion fish > ~/.config/fish/completions/k8stool.fish

PowerShell:
  k8stool completion powershell | Out-String | Invoke-Expression

  # To load completions for every new session, run:
  k8stool completion powershell > k8stool.ps1
  # and source this file from your PowerShell profile.
`,
	DisableFlagsInUseLine: true,
	ValidArgs:             []string{"bash", "zsh", "fish", "powershell"},
	Args:                  cobra.MatchAll(cobra.ExactArgs(1), cobra.OnlyValidArgs),
	RunE: func(cmd *cobra.Command, args []string) error {
		switch args[0] {
		case "bash":
			return cmd.Root().GenBashCompletion(os.Stdout)
		case "zsh":
			return cmd.Root().GenZshCompletion(os.Stdout)
		case "fish":
			return cmd.Root().GenFishCompletion(os.Stdout, true)
		case "powershell":
			return cmd.Root().GenPowerShellCompletionWithDesc(os.Stdout)
		}
		return nil
	},
}

func init() {
	rootCmd.AddCommand(completionCmd)
}
```

### Dynamic Completions with Custom Functions

For flags that have dynamic valid values (e.g., environment names from config), use `RegisterFlagCompletionFunc`:

```go
// In cmd/deploy.go init(), after adding the --env flag:
rootCmd.RegisterFlagCompletionFunc("env", func(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
    // Return completions with descriptions using \t separator
    envs := []string{
        "dev\tDevelopment environment",
        "staging\tStaging/QA environment",
        "prod\tProduction environment",
    }

    // Filter based on what the user has typed so far
    var filtered []string
    for _, e := range envs {
        if strings.HasPrefix(e, toComplete) {
            filtered = append(filtered, e)
        }
    }

    return filtered, cobra.ShellCompDirectiveNoFileComp
})

// For --output flag with fixed values:
rootCmd.RegisterFlagCompletionFunc("output", func(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
    return []string{
        "table\tHuman-readable table format",
        "json\tMachine-readable JSON format",
        "yaml\tKubernetes-style YAML format",
        "wide\tTable with additional columns",
    }, cobra.ShellCompDirectiveNoFileComp
})
```

## Output Formatting

A consistent output layer that respects `--output` across all commands:

```go
// internal/output/output.go
package output

import (
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/olekukonko/tablewriter"
	"gopkg.in/yaml.v3"
)

type Renderer struct {
	Format  string
	NoColor bool
	Writer  io.Writer
}

func New(format string, noColor bool) *Renderer {
	return &Renderer{
		Format:  format,
		NoColor: noColor,
		Writer:  os.Stdout,
	}
}

// Table renders data as an ASCII table.
// headers is a slice of column names; rows is a 2D slice of values.
func (r *Renderer) Table(headers []string, rows [][]string) error {
	table := tablewriter.NewWriter(r.Writer)
	table.SetHeader(headers)
	table.SetBorder(false)
	table.SetColumnSeparator("  ")
	table.SetHeaderAlignment(tablewriter.ALIGN_LEFT)
	table.SetAlignment(tablewriter.ALIGN_LEFT)

	if !r.NoColor {
		table.SetHeaderColor(
			tablewriter.Colors{tablewriter.Bold, tablewriter.FgCyanColor},
		)
	}

	for _, row := range rows {
		table.Append(row)
	}
	table.Render()
	return nil
}

// JSON renders data as formatted JSON.
func (r *Renderer) JSON(v interface{}) error {
	enc := json.NewEncoder(r.Writer)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}

// YAML renders data as YAML.
func (r *Renderer) YAML(v interface{}) error {
	enc := yaml.NewEncoder(r.Writer)
	enc.SetIndent(2)
	return enc.Encode(v)
}

// Render dispatches to the appropriate format based on r.Format.
func (r *Renderer) Render(tableHeaders []string, tableRows [][]string, structData interface{}) error {
	switch r.Format {
	case "json":
		return r.JSON(structData)
	case "yaml":
		return r.YAML(structData)
	case "table", "wide":
		return r.Table(tableHeaders, tableRows)
	default:
		return fmt.Errorf("unknown output format: %s", r.Format)
	}
}
```

## Version Command

```go
// cmd/version.go
package cmd

import (
	"fmt"
	"runtime"

	"github.com/spf13/cobra"
	"github.com/spf13/viper"
)

type versionInfo struct {
	Version   string `json:"version" yaml:"version"`
	Commit    string `json:"commit" yaml:"commit"`
	BuildDate string `json:"buildDate" yaml:"buildDate"`
	BuiltBy   string `json:"builtBy" yaml:"builtBy"`
	GoVersion string `json:"goVersion" yaml:"goVersion"`
	OS        string `json:"os" yaml:"os"`
	Arch      string `json:"arch" yaml:"arch"`
}

var (
	versionStr   = "dev"
	commitStr    = "none"
	buildDateStr = "unknown"
	builtByStr   = "unknown"
)

// SetVersionInfo is called from main.go with linker-injected values.
func SetVersionInfo(version, commit, buildDate, builtBy string) {
	versionStr = version
	commitStr = commit
	buildDateStr = buildDate
	builtByStr = builtBy
}

var versionCmd = &cobra.Command{
	Use:   "version",
	Short: "Print version information",
	RunE: func(cmd *cobra.Command, args []string) error {
		info := versionInfo{
			Version:   versionStr,
			Commit:    commitStr,
			BuildDate: buildDateStr,
			BuiltBy:   builtByStr,
			GoVersion: runtime.Version(),
			OS:        runtime.GOOS,
			Arch:      runtime.GOARCH,
		}

		output := viper.GetString("output")
		switch output {
		case "json":
			renderer.JSON(info)
		case "yaml":
			renderer.YAML(info)
		default:
			fmt.Printf("k8stool version %s\n", info.Version)
			fmt.Printf("  commit:     %s\n", info.Commit)
			fmt.Printf("  built:      %s\n", info.BuildDate)
			fmt.Printf("  built by:   %s\n", info.BuiltBy)
			fmt.Printf("  go version: %s\n", info.GoVersion)
			fmt.Printf("  os/arch:    %s/%s\n", info.OS, info.Arch)
		}
		return nil
	},
}

func init() {
	rootCmd.AddCommand(versionCmd)
}
```

## Testing CLI Commands

Testing Cobra commands requires capturing stdout/stderr and simulating flag inputs.

```go
// cmd/deploy_app_test.go
package cmd

import (
	"bytes"
	"testing"

	"github.com/spf13/viper"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestDeployAppRequiresEnv(t *testing.T) {
	// Reset Viper state between tests
	viper.Reset()

	buf := new(bytes.Buffer)
	rootCmd.SetOut(buf)
	rootCmd.SetErr(buf)

	rootCmd.SetArgs([]string{
		"deploy", "app", "my-service",
		"--image", "v1.2.3",
		// Intentionally omitting --env
	})

	err := rootCmd.Execute()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "--env is required")
}

func TestDeployAppDryRun(t *testing.T) {
	viper.Reset()

	buf := new(bytes.Buffer)
	rootCmd.SetOut(buf)

	rootCmd.SetArgs([]string{
		"deploy", "app", "my-service",
		"--image", "v1.2.3",
		"--env", "dev",
		"--dry-run",
	})

	err := rootCmd.Execute()
	require.NoError(t, err)
	assert.Contains(t, buf.String(), "DRY RUN")
}

func TestVersionOutputJSON(t *testing.T) {
	viper.Reset()
	SetVersionInfo("v1.0.0", "abc123", "2031-01-01", "test")

	buf := new(bytes.Buffer)
	rootCmd.SetOut(buf)

	rootCmd.SetArgs([]string{"version", "--output", "json"})

	err := rootCmd.Execute()
	require.NoError(t, err)
	assert.Contains(t, buf.String(), `"version"`)
	assert.Contains(t, buf.String(), `"v1.0.0"`)
}
```

## Error Handling and User Experience

Production CLIs distinguish between user errors (wrong flags, missing config) and system errors (API unreachable, timeout). Users need different messages for each.

```go
// internal/errors/errors.go
package errors

import (
	"errors"
	"fmt"
)

// UserError indicates a problem with how the user invoked the command.
// These errors are shown without a stack trace.
type UserError struct {
	Message string
	Hint    string
}

func (e *UserError) Error() string {
	if e.Hint != "" {
		return fmt.Sprintf("%s\n\nHint: %s", e.Message, e.Hint)
	}
	return e.Message
}

// NewUserError creates a UserError with an optional hint.
func NewUserError(message, hint string) error {
	return &UserError{Message: message, Hint: hint}
}

// IsUserError returns true if the error is a UserError.
func IsUserError(err error) bool {
	var userErr *UserError
	return errors.As(err, &userErr)
}
```

In the root command's post-execution error handler:

```go
// In Execute(), wrap the cobra Execute call:
func Execute() error {
	err := rootCmd.Execute()
	if err != nil {
		if errors.IsUserError(err) {
			// User errors: show message, suggest --help, no stack trace
			fmt.Fprintf(os.Stderr, "Error: %v\n\nRun '%s --help' for usage.\n",
				err, rootCmd.CommandPath())
		} else {
			// System errors: show full context
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			if viper.GetBool("debug") {
				fmt.Fprintf(os.Stderr, "\nStack trace:\n%+v\n", err)
			}
		}
	}
	return err
}
```

## Makefile for Development

```makefile
# Makefile
BINARY=k8stool
VERSION=$(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
COMMIT=$(shell git rev-parse --short HEAD 2>/dev/null || echo "none")
BUILD_DATE=$(shell date -u +"%Y-%m-%dT%H:%M:%SZ")
BUILT_BY=$(shell whoami)

LDFLAGS=-ldflags "\
  -X main.version=$(VERSION) \
  -X main.commit=$(COMMIT) \
  -X main.buildDate=$(BUILD_DATE) \
  -X main.builtBy=$(BUILT_BY)"

.PHONY: build test lint install completion

build:
	go build $(LDFLAGS) -o $(BINARY) .

test:
	go test ./... -v -race -count=1

lint:
	golangci-lint run ./...

install: build
	mv $(BINARY) $(GOPATH)/bin/$(BINARY)

# Install shell completions for the current user
completion-bash: build
	mkdir -p ~/.local/share/bash-completion/completions
	./$(BINARY) completion bash > ~/.local/share/bash-completion/completions/k8stool

completion-zsh: build
	mkdir -p ~/.zsh/completions
	./$(BINARY) completion zsh > ~/.zsh/completions/_k8stool
	@echo "Add 'fpath=(~/.zsh/completions \$$fpath)' to your .zshrc"

completion-fish: build
	./$(BINARY) completion fish > ~/.config/fish/completions/k8stool.fish
```

## Conclusion

A well-structured Go CLI with Cobra and Viper handles the full configuration lifecycle: defaults in code, user config file, environment variable overrides, and final command-line flag precedence. Combined with dynamic shell completions and a consistent output layer, the result is a tool that engineers reach for by default rather than writing one-off scripts. The patterns here scale from a single-developer tool to a shared platform CLI maintained by dozens of engineers.
