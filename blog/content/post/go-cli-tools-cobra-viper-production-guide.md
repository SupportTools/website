---
title: "Production CLI Tools in Go: cobra, viper, and Distribution Patterns"
date: 2028-11-03T00:00:00-05:00
draft: false
tags: ["Go", "CLI", "cobra", "viper", "DevOps"]
categories:
- Go
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to building production-grade CLI tools in Go using cobra and viper: command structure, config file and environment variable binding, interactive prompts, progress bars, table output, shell completion, cross-platform builds with GoReleaser, and testing CLI commands."
more_link: "yes"
url: "/go-cli-tools-cobra-viper-production-guide/"
---

Go is the dominant language for DevOps tooling — kubectl, helm, terraform, docker, and dozens of other production tools are written in it. The reasons are practical: fast startup, single binary distribution, cross-platform compilation, and strong standard library. When you build your own internal tooling or open-source CLI tools, the cobra + viper combination provides a battle-tested foundation that handles argument parsing, configuration management, and shell completion.

This guide builds a complete, production-ready CLI tool from scratch: a hypothetical `clustertool` that manages Kubernetes clusters. It covers the full stack from command structure through GoReleaser distribution and comprehensive testing.

<!--more-->

# Production CLI Tools in Go: cobra, viper, and Distribution Patterns

## Project Structure

Before writing a line of code, establish the project structure. Well-organized CLI projects are easier to test and contribute to:

```
clustertool/
├── cmd/
│   ├── root.go           # Root command, global flags, viper init
│   ├── cluster/
│   │   ├── cluster.go    # cluster subcommand group
│   │   ├── create.go     # cluster create
│   │   ├── delete.go     # cluster delete
│   │   └── list.go       # cluster list
│   ├── node/
│   │   ├── node.go       # node subcommand group
│   │   ├── drain.go      # node drain
│   │   └── list.go       # node list
│   └── completion/
│       └── completion.go # shell completion command
├── internal/
│   ├── config/
│   │   └── config.go     # Config struct and loading
│   ├── client/
│   │   └── client.go     # Kubernetes client
│   └── output/
│       └── table.go      # Table formatter
├── main.go
├── .goreleaser.yaml
└── go.mod
```

## Dependencies

```bash
go mod init github.com/example/clustertool

go get github.com/spf13/cobra@v1.8.1
go get github.com/spf13/viper@v1.19.0
go get github.com/AlecAivazis/survey/v2@v2.3.7
go get github.com/vbauerster/mpb/v8@v8.8.3
go get github.com/olekukonko/tablewriter@v0.0.5
go get github.com/fatih/color@v1.17.0
go get go.uber.org/zap@v1.27.0
```

## Root Command

The root command initializes viper and defines persistent (global) flags that apply to all subcommands:

```go
// cmd/root.go
package cmd

import (
	"fmt"
	"os"
	"strings"

	"github.com/example/clustertool/internal/config"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

var (
	cfgFile string
	verbose bool
	output  string
	logger  *zap.Logger
)

// rootCmd is the top-level command. All subcommands are children of this.
var rootCmd = &cobra.Command{
	Use:   "clustertool",
	Short: "Manage Kubernetes clusters and nodes",
	Long: `clustertool is a CLI tool for managing Kubernetes clusters.
It supports cluster lifecycle operations, node management, and
workload inspection across multiple environments.`,
	// PersistentPreRunE runs before any subcommand's RunE.
	// Use it for initialization that all commands need (logging, auth).
	PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
		return initializeLogger()
	},
}

// Execute is the entry point called from main().
func Execute() {
	if err := rootCmd.Execute(); err != nil {
		os.Exit(1)
	}
}

func init() {
	// cobra.OnInitialize runs after flag parsing but before any command executes.
	cobra.OnInitialize(initConfig)

	// Persistent flags are inherited by all subcommands.
	rootCmd.PersistentFlags().StringVar(&cfgFile, "config", "",
		"config file (default: $HOME/.clustertool.yaml)")
	rootCmd.PersistentFlags().BoolVarP(&verbose, "verbose", "v", false,
		"enable verbose output")
	rootCmd.PersistentFlags().StringVarP(&output, "output", "o", "table",
		"output format: table|json|yaml")

	// Bind persistent flags to viper so they can also be set via
	// config file or environment variables.
	viper.BindPFlag("verbose", rootCmd.PersistentFlags().Lookup("verbose"))
	viper.BindPFlag("output", rootCmd.PersistentFlags().Lookup("output"))

	// Register subcommands
	rootCmd.AddCommand(clusterCmd)
	rootCmd.AddCommand(nodeCmd)
	rootCmd.AddCommand(completionCmd)
}

func initConfig() {
	if cfgFile != "" {
		// Use the explicitly specified config file.
		viper.SetConfigFile(cfgFile)
	} else {
		home, err := os.UserHomeDir()
		if err != nil {
			fmt.Fprintf(os.Stderr, "error finding home directory: %v\n", err)
			os.Exit(1)
		}

		// Search order: current directory, then home directory.
		viper.AddConfigPath(".")
		viper.AddConfigPath(home)
		viper.SetConfigType("yaml")
		viper.SetConfigName(".clustertool")
	}

	// Environment variable prefix: CLUSTERTOOL_KUBECONFIG, CLUSTERTOOL_VERBOSE, etc.
	viper.SetEnvPrefix("CLUSTERTOOL")
	viper.SetEnvKeyReplacer(strings.NewReplacer("-", "_", ".", "_"))
	viper.AutomaticEnv()

	// Read the config file. It's OK if it doesn't exist.
	if err := viper.ReadInConfig(); err != nil {
		if _, ok := err.(viper.ConfigFileNotFoundError); !ok {
			fmt.Fprintf(os.Stderr, "error reading config: %v\n", err)
			os.Exit(1)
		}
	}
}

func initializeLogger() error {
	level := zapcore.InfoLevel
	if viper.GetBool("verbose") {
		level = zapcore.DebugLevel
	}

	cfg := zap.NewProductionConfig()
	cfg.Level = zap.NewAtomicLevelAt(level)
	cfg.Encoding = "console"
	cfg.EncoderConfig.EncodeTime = zapcore.ISO8601TimeEncoder
	cfg.EncoderConfig.EncodeLevel = zapcore.CapitalColorLevelEncoder

	var err error
	logger, err = cfg.Build()
	if err != nil {
		return fmt.Errorf("building logger: %w", err)
	}
	return nil
}
```

## Config Structure with Viper

Use a typed config struct bound to viper for clean access patterns:

```go
// internal/config/config.go
package config

import (
	"fmt"
	"time"

	"github.com/spf13/viper"
)

// Config is the application configuration. Fields map to viper keys.
type Config struct {
	KubeConfig  string        `mapstructure:"kubeconfig"`
	Context     string        `mapstructure:"context"`
	Namespace   string        `mapstructure:"namespace"`
	Timeout     time.Duration `mapstructure:"timeout"`
	Output      string        `mapstructure:"output"`
	Verbose     bool          `mapstructure:"verbose"`
	APIEndpoint string        `mapstructure:"api_endpoint"`
	APIToken    string        `mapstructure:"api_token"`
}

// Load reads the current viper state into a typed Config struct.
func Load() (*Config, error) {
	// Set defaults. These apply if neither config file nor environment
	// variables nor flags provide a value.
	viper.SetDefault("namespace", "default")
	viper.SetDefault("timeout", "30s")
	viper.SetDefault("output", "table")
	viper.SetDefault("kubeconfig", kubeConfigDefault())

	cfg := &Config{}
	if err := viper.Unmarshal(cfg); err != nil {
		return nil, fmt.Errorf("unmarshaling config: %w", err)
	}
	return cfg, nil
}

func kubeConfigDefault() string {
	// Standard Kubernetes default
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".kube", "config")
}
```

Example config file (`.clustertool.yaml`):

```yaml
# ~/.clustertool.yaml
kubeconfig: /home/user/.kube/config
context: production-us-east-1
namespace: default
timeout: 60s
output: table
api_endpoint: https://api.example.com
# api_token is better set via CLUSTERTOOL_API_TOKEN environment variable
```

## Subcommand with Local Flags

```go
// cmd/cluster/cluster.go
package cmd

import (
	"github.com/spf13/cobra"
)

var clusterCmd = &cobra.Command{
	Use:   "cluster",
	Short: "Manage Kubernetes clusters",
	Long:  "Create, list, and manage Kubernetes clusters.",
}

func init() {
	clusterCmd.AddCommand(clusterCreateCmd)
	clusterCmd.AddCommand(clusterListCmd)
	clusterCmd.AddCommand(clusterDeleteCmd)
}
```

```go
// cmd/cluster/create.go
package cmd

import (
	"context"
	"fmt"

	"github.com/AlecAivazis/survey/v2"
	"github.com/example/clustertool/internal/config"
	"github.com/example/clustertool/internal/output"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
)

var clusterCreateCmd = &cobra.Command{
	Use:   "create [NAME]",
	Short: "Create a new Kubernetes cluster",
	Long: `Create a new Kubernetes cluster with the specified configuration.
If --interactive is specified, prompts for missing values.`,
	Args: cobra.MaximumNArgs(1),
	RunE: runClusterCreate,
}

// These are local to the create command only
var (
	createNodeCount  int
	createNodeType   string
	createRegion     string
	createVersion    string
	createInteractive bool
)

func init() {
	clusterCreateCmd.Flags().IntVar(&createNodeCount, "nodes", 3,
		"number of worker nodes")
	clusterCreateCmd.Flags().StringVar(&createNodeType, "node-type", "m5.large",
		"worker node instance type")
	clusterCreateCmd.Flags().StringVar(&createRegion, "region", "",
		"cloud provider region")
	clusterCreateCmd.Flags().StringVar(&createVersion, "k8s-version", "1.31",
		"Kubernetes version")
	clusterCreateCmd.Flags().BoolVarP(&createInteractive, "interactive", "i", false,
		"interactive mode with prompts")

	// Mark region as required
	clusterCreateCmd.MarkFlagRequired("region")
}

func runClusterCreate(cmd *cobra.Command, args []string) error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("loading config: %w", err)
	}

	clusterName := ""
	if len(args) > 0 {
		clusterName = args[0]
	}

	// Interactive mode fills in missing values via prompts
	if createInteractive || clusterName == "" {
		clusterName, err = promptForClusterName(clusterName)
		if err != nil {
			return err
		}
	}

	if viper.GetBool("verbose") {
		fmt.Printf("Creating cluster %q in %s with %d x %s nodes (k8s %s)\n",
			clusterName, createRegion, createNodeCount, createNodeType, createVersion)
	}

	ctx, cancel := context.WithTimeout(context.Background(), cfg.Timeout)
	defer cancel()

	// Show a progress bar during long operations
	cluster, err := createClusterWithProgress(ctx, clusterName, cfg)
	if err != nil {
		return fmt.Errorf("creating cluster: %w", err)
	}

	return output.Print(cmd.OutOrStdout(), cfg.Output, cluster)
}

func promptForClusterName(current string) (string, error) {
	if current != "" {
		return current, nil
	}

	var name string
	prompt := &survey.Input{
		Message: "Cluster name:",
		Help:    "A unique name for this cluster (lowercase alphanumeric and hyphens)",
		Suggest: func(toComplete string) []string {
			return []string{"prod-us-east-1", "staging-us-west-2", "dev-eu-west-1"}
		},
	}
	validate := survey.WithValidator(survey.Required)
	if err := survey.AskOne(prompt, &name, validate); err != nil {
		return "", fmt.Errorf("prompt: %w", err)
	}
	return name, nil
}
```

## Interactive Prompts with survey

For complex interactive operations like confirming destructive actions:

```go
// cmd/cluster/delete.go
package cmd

import (
	"fmt"

	"github.com/AlecAivazis/survey/v2"
	"github.com/fatih/color"
	"github.com/spf13/cobra"
)

var clusterDeleteCmd = &cobra.Command{
	Use:   "delete NAME",
	Short: "Delete a cluster",
	Args:  cobra.ExactArgs(1),
	RunE:  runClusterDelete,
}

var deleteForce bool

func init() {
	clusterDeleteCmd.Flags().BoolVar(&deleteForce, "force", false,
		"skip confirmation prompt")
}

func runClusterDelete(cmd *cobra.Command, args []string) error {
	clusterName := args[0]

	if !deleteForce {
		// Confirmation prompt with danger styling
		warning := color.New(color.FgRed, color.Bold)
		warning.Fprintf(cmd.ErrOrStderr(),
			"WARNING: This will permanently delete cluster %q and all its data.\n",
			clusterName)

		var confirmed bool
		prompt := &survey.Confirm{
			Message: fmt.Sprintf("Are you sure you want to delete %q?", clusterName),
			Default: false,
		}
		if err := survey.AskOne(prompt, &confirmed); err != nil {
			return fmt.Errorf("prompt: %w", err)
		}
		if !confirmed {
			fmt.Fprintln(cmd.OutOrStdout(), "Deletion cancelled.")
			return nil
		}

		// Require typing the cluster name for high-stakes operations
		var typedName string
		confirmPrompt := &survey.Input{
			Message: fmt.Sprintf("Type %q to confirm:", clusterName),
		}
		if err := survey.AskOne(confirmPrompt, &typedName); err != nil {
			return err
		}
		if typedName != clusterName {
			return fmt.Errorf("confirmation failed: typed %q, expected %q", typedName, clusterName)
		}
	}

	fmt.Fprintf(cmd.OutOrStdout(), "Deleting cluster %q...\n", clusterName)
	// Actual deletion logic here
	return nil
}
```

## Progress Bars with mpb

For long-running operations, progress bars communicate status better than log lines:

```go
// internal/progress/progress.go
package progress

import (
	"context"
	"fmt"
	"io"
	"time"

	"github.com/vbauerster/mpb/v8"
	"github.com/vbauerster/mpb/v8/decor"
)

// ClusterCreateProgress shows multi-phase progress for cluster creation.
func ClusterCreateProgress(ctx context.Context, w io.Writer, clusterName string, fn func(ctx context.Context) error) error {
	p := mpb.New(
		mpb.WithWidth(60),
		mpb.WithOutput(w),
		mpb.WithRefreshRate(100*time.Millisecond),
	)

	phases := []struct {
		name     string
		duration time.Duration
	}{
		{"Provisioning control plane", 30 * time.Second},
		{"Configuring networking", 15 * time.Second},
		{"Joining worker nodes", 45 * time.Second},
		{"Installing cluster components", 20 * time.Second},
		{"Running health checks", 10 * time.Second},
	}

	totalSteps := int64(len(phases))
	overall := p.New(totalSteps,
		mpb.BarStyle().Rbound("|"),
		mpb.PrependDecorators(
			decor.Name("Overall", decor.WC{C: decor.DindentRight | decor.DextraSpace}),
			decor.CountersNoUnit("[%d / %d]"),
		),
		mpb.AppendDecorators(
			decor.OnComplete(decor.Percentage(decor.WC{W: 5}), "Done!"),
		),
	)

	for i, phase := range phases {
		bar := p.New(100,
			mpb.BarStyle().Rbound("|"),
			mpb.PrependDecorators(
				decor.Name(fmt.Sprintf("  %s", phase.name), decor.WCSyncSpaceR),
			),
			mpb.AppendDecorators(
				decor.OnComplete(decor.Percentage(), " ✓"),
			),
		)

		// Simulate phase progress (replace with actual operation)
		ticker := time.NewTicker(phase.duration / 100)
		for j := 0; j < 100; j++ {
			select {
			case <-ctx.Done():
				p.Abort(false)
				return ctx.Err()
			case <-ticker.C:
				bar.Increment()
			}
		}
		ticker.Stop()
		overall.Increment()
		_ = i
	}

	p.Wait()
	return fn(ctx)
}
```

## Table Output with tablewriter

Consistent table formatting across commands:

```go
// internal/output/table.go
package output

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"reflect"
	"strings"

	"github.com/fatih/color"
	"github.com/olekukonko/tablewriter"
	"gopkg.in/yaml.v3"
)

type Cluster struct {
	Name       string `json:"name"        yaml:"name"        table:"NAME"`
	Region     string `json:"region"      yaml:"region"      table:"REGION"`
	Status     string `json:"status"      yaml:"status"      table:"STATUS"`
	NodeCount  int    `json:"node_count"  yaml:"node_count"  table:"NODES"`
	K8sVersion string `json:"k8s_version" yaml:"k8s_version" table:"VERSION"`
	Age        string `json:"age"         yaml:"age"         table:"AGE"`
}

// Print outputs data in the requested format.
func Print(w io.Writer, format string, data interface{}) error {
	switch format {
	case "json":
		enc := json.NewEncoder(w)
		enc.SetIndent("", "  ")
		return enc.Encode(data)
	case "yaml":
		enc := yaml.NewEncoder(w)
		enc.SetIndent(2)
		return enc.Encode(data)
	case "table":
		return printTable(w, data)
	default:
		return fmt.Errorf("unknown output format: %q (valid: table, json, yaml)", format)
	}
}

func printTable(w io.Writer, data interface{}) error {
	table := tablewriter.NewWriter(w)
	table.SetBorder(false)
	table.SetColumnSeparator(" ")
	table.SetHeaderLine(false)
	table.SetAlignment(tablewriter.ALIGN_LEFT)
	table.SetHeaderAlignment(tablewriter.ALIGN_LEFT)
	table.SetTablePadding("  ")
	table.SetNoWhiteSpace(true)

	v := reflect.ValueOf(data)
	if v.Kind() == reflect.Ptr {
		v = v.Elem()
	}

	// Handle both single items and slices
	var rows []reflect.Value
	if v.Kind() == reflect.Slice {
		for i := 0; i < v.Len(); i++ {
			rows = append(rows, v.Index(i))
		}
	} else {
		rows = []reflect.Value{v}
	}

	if len(rows) == 0 {
		fmt.Fprintln(w, "No resources found.")
		return nil
	}

	// Extract headers from struct tags
	t := rows[0].Type()
	if t.Kind() == reflect.Ptr {
		t = t.Elem()
	}
	var headers []string
	for i := 0; i < t.NumField(); i++ {
		tag := t.Field(i).Tag.Get("table")
		if tag != "" && tag != "-" {
			headers = append(headers, tag)
		}
	}
	table.SetHeader(headers)

	// Populate rows
	for _, row := range rows {
		if row.Kind() == reflect.Ptr {
			row = row.Elem()
		}
		var cells []string
		for i := 0; i < t.NumField(); i++ {
			tag := t.Field(i).Tag.Get("table")
			if tag == "" || tag == "-" {
				continue
			}
			field := row.Field(i)
			cell := fmt.Sprintf("%v", field.Interface())

			// Color-code the status field
			if tag == "STATUS" {
				switch strings.ToLower(cell) {
				case "running", "ready", "active":
					cell = color.GreenString(cell)
				case "pending", "creating", "updating":
					cell = color.YellowString(cell)
				case "failed", "error", "deleting":
					cell = color.RedString(cell)
				}
			}
			cells = append(cells, cell)
		}
		table.Append(cells)
	}

	table.Render()
	return nil
}
```

## Shell Completion

cobra generates shell completion scripts automatically. Register custom completion logic for dynamic values:

```go
// cmd/completion/completion.go
package cmd

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

var completionCmd = &cobra.Command{
	Use:   "completion [bash|zsh|fish|powershell]",
	Short: "Generate shell completion scripts",
	Long: `Generate shell completion scripts for clustertool.

Installation:
  # bash (add to ~/.bashrc)
  source <(clustertool completion bash)

  # zsh (add to ~/.zshrc)
  source <(clustertool completion zsh)
  compdef _clustertool clustertool

  # fish
  clustertool completion fish | source

  # PowerShell (add to $PROFILE)
  clustertool completion powershell | Out-String | Invoke-Expression`,
	ValidArgs:             []string{"bash", "zsh", "fish", "powershell"},
	Args:                  cobra.MatchAll(cobra.ExactArgs(1), cobra.OnlyValidArgs),
	DisableFlagsInUseLine: true,
	RunE: func(cmd *cobra.Command, args []string) error {
		switch args[0] {
		case "bash":
			return cmd.Root().GenBashCompletionV2(os.Stdout, true)
		case "zsh":
			return cmd.Root().GenZshCompletion(os.Stdout)
		case "fish":
			return cmd.Root().GenFishCompletion(os.Stdout, true)
		case "powershell":
			return cmd.Root().GenPowerShellCompletionWithDesc(os.Stdout)
		default:
			return fmt.Errorf("unsupported shell: %s", args[0])
		}
	},
}
```

Register dynamic completion for flag values (e.g., complete cluster names from the API):

```go
func init() {
	// Register completion function for --region flag
	clusterCreateCmd.RegisterFlagCompletionFunc("region", func(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
		// In production, query the API; here we return static values
		regions := []string{
			"us-east-1\tUS East (N. Virginia)",
			"us-west-2\tUS West (Oregon)",
			"eu-west-1\tEurope (Ireland)",
			"ap-southeast-1\tAsia Pacific (Singapore)",
		}
		return regions, cobra.ShellCompDirectiveNoFileComp
	})

	// Register completion for cluster NAME argument in delete command
	clusterDeleteCmd.ValidArgsFunction = func(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
		if len(args) != 0 {
			return nil, cobra.ShellCompDirectiveNoFileComp
		}
		// Query actual cluster names
		clusters, err := listClusterNames(toComplete)
		if err != nil {
			return nil, cobra.ShellCompDirectiveError
		}
		return clusters, cobra.ShellCompDirectiveNoFileComp
	}
}

func listClusterNames(prefix string) ([]string, error) {
	// In production, call your API here
	return []string{"prod-us-east-1", "staging-us-west-2", "dev-eu-west-1"}, nil
}
```

## GoReleaser Configuration

GoReleaser handles cross-platform builds, checksums, release artifacts, and package managers:

```yaml
# .goreleaser.yaml
version: 2

project_name: clustertool

before:
  hooks:
    - go mod tidy
    - go generate ./...

builds:
  - env:
      - CGO_ENABLED=0
    goos:
      - linux
      - darwin
      - windows
    goarch:
      - amd64
      - arm64
    # Inject build-time version information
    ldflags:
      - -s -w
      - -X github.com/example/clustertool/internal/version.Version={{.Version}}
      - -X github.com/example/clustertool/internal/version.Commit={{.Commit}}
      - -X github.com/example/clustertool/internal/version.BuildDate={{.Date}}
    main: .

archives:
  - id: default
    formats: [tar.gz]
    format_overrides:
      - goos: windows
        formats: [zip]
    name_template: "{{ .ProjectName }}_{{ .Os }}_{{ .Arch }}"
    files:
      - LICENSE
      - README.md

checksum:
  name_template: "checksums.txt"
  algorithm: sha256

changelog:
  sort: asc
  use: github
  filters:
    exclude:
      - "^docs:"
      - "^test:"
      - "^ci:"
      - Merge pull request
      - Merge branch

# Homebrew tap formula
brews:
  - repository:
      owner: example
      name: homebrew-tap
      token: "{{ .Env.HOMEBREW_TAP_TOKEN }}"
    homepage: https://github.com/example/clustertool
    description: "Manage Kubernetes clusters"
    license: Apache-2.0
    folder: Formula
    install: |
      bin.install "clustertool"
      bash_completion.install "completions/clustertool.bash" => "clustertool"
      zsh_completion.install "completions/clustertool.zsh" => "_clustertool"
      fish_completion.install "completions/clustertool.fish"
    test: |
      system "#{bin}/clustertool", "--version"

# Docker images
dockers:
  - image_templates:
      - "ghcr.io/example/clustertool:{{ .Tag }}-amd64"
    dockerfile: Dockerfile
    use: buildx
    build_flag_templates:
      - "--platform=linux/amd64"
    goarch: amd64

  - image_templates:
      - "ghcr.io/example/clustertool:{{ .Tag }}-arm64"
    dockerfile: Dockerfile
    use: buildx
    build_flag_templates:
      - "--platform=linux/arm64"
    goarch: arm64

docker_manifests:
  - name_template: "ghcr.io/example/clustertool:{{ .Tag }}"
    image_templates:
      - "ghcr.io/example/clustertool:{{ .Tag }}-amd64"
      - "ghcr.io/example/clustertool:{{ .Tag }}-arm64"

# GitHub Releases
release:
  github:
    owner: example
    name: clustertool
  name_template: "v{{.Version}}"
  header: |
    ## clustertool v{{.Version}}

    See the [CHANGELOG](CHANGELOG.md) for full details.
```

Version information injection:

```go
// internal/version/version.go
package version

import (
	"fmt"
	"runtime"
)

// These variables are set at build time by GoReleaser via ldflags.
var (
	Version   = "dev"
	Commit    = "unknown"
	BuildDate = "unknown"
)

func String() string {
	return fmt.Sprintf("%s (commit: %s, built: %s, %s/%s)",
		Version, Commit, BuildDate, runtime.GOOS, runtime.GOARCH)
}
```

```go
// cmd/version.go
var versionCmd = &cobra.Command{
	Use:   "version",
	Short: "Print version information",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Fprintln(cmd.OutOrStdout(), "clustertool "+version.String())
	},
}
```

## Testing CLI Commands

cobra makes commands testable by separating output to `cmd.OutOrStdout()` and `cmd.ErrOrStderr()`:

```go
// cmd/cluster_test.go
package cmd_test

import (
	"bytes"
	"strings"
	"testing"

	"github.com/example/clustertool/cmd"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
)

// executeCommand runs a cobra command and returns stdout, stderr, and error.
func executeCommand(root *cobra.Command, args ...string) (stdout, stderr string, err error) {
	outBuf := new(bytes.Buffer)
	errBuf := new(bytes.Buffer)
	root.SetOut(outBuf)
	root.SetErr(errBuf)
	root.SetArgs(args)
	_, err = root.ExecuteC()
	return outBuf.String(), errBuf.String(), err
}

func TestClusterList_TableOutput(t *testing.T) {
	// Reset viper state between tests
	viper.Reset()
	viper.Set("output", "table")

	root := buildTestRoot(t)
	stdout, _, err := executeCommand(root, "cluster", "list")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Verify table header is present
	if !strings.Contains(stdout, "NAME") {
		t.Errorf("expected table header NAME in output:\n%s", stdout)
	}
}

func TestClusterList_JSONOutput(t *testing.T) {
	viper.Reset()

	root := buildTestRoot(t)
	stdout, _, err := executeCommand(root, "cluster", "list", "--output", "json")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Verify valid JSON
	if !strings.HasPrefix(strings.TrimSpace(stdout), "[") &&
		!strings.HasPrefix(strings.TrimSpace(stdout), "{") {
		t.Errorf("expected JSON output, got:\n%s", stdout)
	}
}

func TestClusterCreate_RequiredFlag(t *testing.T) {
	viper.Reset()

	root := buildTestRoot(t)
	// Missing required --region flag should return error
	_, _, err := executeCommand(root, "cluster", "create", "test-cluster")
	if err == nil {
		t.Fatal("expected error for missing --region flag")
	}
	if !strings.Contains(err.Error(), "region") {
		t.Errorf("expected error to mention 'region', got: %v", err)
	}
}

func TestClusterDelete_ForceFlagSkipsPrompt(t *testing.T) {
	viper.Reset()

	root := buildTestRoot(t)
	stdout, _, err := executeCommand(root, "cluster", "delete",
		"test-cluster", "--force")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(stdout, "Deleting cluster") {
		t.Errorf("expected deletion message, got:\n%s", stdout)
	}
}

func TestVersionCommand(t *testing.T) {
	root := buildTestRoot(t)
	stdout, _, err := executeCommand(root, "version")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(stdout, "clustertool") {
		t.Errorf("expected 'clustertool' in version output, got:\n%s", stdout)
	}
}

// buildTestRoot creates a fresh root command for each test to avoid state leakage.
func buildTestRoot(t *testing.T) *cobra.Command {
	t.Helper()
	// Build from scratch — do not use the package-level rootCmd
	// which shares state across tests.
	return cmd.NewRootCommand()
}
```

## Viper Precedence Chain

Understanding the configuration priority order prevents debugging headaches:

```
Priority (highest to lowest):
1. Explicit Set() calls in code
2. Flag values (--flag=value on command line)
3. Environment variables (CLUSTERTOOL_REGION=us-east-1)
4. Config file values (.clustertool.yaml)
5. Key/Value store (Consul, etcd — if configured)
6. Default values (viper.SetDefault())
```

This means:
- `CLUSTERTOOL_KUBECONFIG=/tmp/test.kubeconfig clustertool cluster list` overrides the config file
- `clustertool --verbose cluster list` overrides `verbose: false` in the config file
- Users can always override tool-wide defaults in `.clustertool.yaml`

## Summary

Building production CLI tools in Go with cobra + viper follows a consistent pattern:

1. **Root command** initializes viper, binds persistent flags, and sets env prefix
2. **Subcommand groups** map to functional areas (cluster, node, workload)
3. **Local flags** are registered in `init()` and bound to viper only when they need config-file support
4. **Config struct** uses `mapstructure` tags and `viper.Unmarshal()` for type-safe access
5. **Interactive prompts** (`survey`) handle human operators; `--force` flags skip them for automation
6. **Output formatting** supports `table`, `json`, and `yaml` — always output to `cmd.OutOrStdout()` for testability
7. **GoReleaser** handles the entire release pipeline: cross-compilation, checksums, Homebrew tap, Docker images, and GitHub releases
8. **Tests** use `executeCommand()` helper and fresh viper state to avoid test pollution
