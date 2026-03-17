---
title: "Go CLI Development: cobra, viper, and Survey for Enterprise Tools"
date: 2031-04-04T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "CLI", "cobra", "viper", "DevOps", "Tooling"]
categories:
- Go
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to building Go CLI tools with cobra for command hierarchy, viper for multi-source configuration, survey for interactive prompts, shell completion, and GoReleaser for distribution."
more_link: "yes"
url: "/go-cli-development-cobra-viper-survey-enterprise-tools/"
---

Enterprise CLI tools require more than a simple main function. They need hierarchical commands, multi-source configuration (flags, environment variables, config files), interactive prompts for complex workflows, shell completion for discoverability, and automated release pipelines for distribution. This guide builds a production-grade CLI tool using the Go ecosystem's standard toolkit.

<!--more-->

# Go CLI Development: cobra, viper, and Survey for Enterprise Tools

## Project Architecture

We'll build `clustertool` — a fictional Kubernetes cluster management CLI — to demonstrate real-world patterns.

```
clustertool/
├── cmd/
│   ├── root.go           # Root command, global flags, viper initialization
│   ├── cluster/
│   │   ├── cluster.go    # cluster subcommand group
│   │   ├── create.go     # cluster create
│   │   ├── delete.go     # cluster delete
│   │   └── list.go       # cluster list
│   ├── config/
│   │   ├── config.go     # config subcommand group
│   │   ├── set.go        # config set
│   │   └── get.go        # config get
│   └── completion.go     # shell completion command
├── internal/
│   ├── client/           # API client
│   ├── config/           # Config loading/saving
│   └── output/           # Output formatting (table, JSON, YAML)
├── main.go
├── .goreleaser.yaml
└── go.mod
```

## Section 1: cobra Command Hierarchy

### Root Command Setup

```bash
go mod init github.com/example/clustertool
go get github.com/spf13/cobra
go get github.com/spf13/viper
go get github.com/AlecAivazis/survey/v2
go get github.com/olekukonko/tablewriter
go get github.com/fatih/color
go get go.uber.org/zap
```

```go
// cmd/root.go
package cmd

import (
    "fmt"
    "os"
    "path/filepath"

    "github.com/spf13/cobra"
    "github.com/spf13/viper"
    "go.uber.org/zap"
    "go.uber.org/zap/zapcore"

    "github.com/example/clustertool/cmd/cluster"
    "github.com/example/clustertool/cmd/config"
    "github.com/example/clustertool/internal/output"
)

var (
    cfgFile  string
    logLevel string
    outFormat string
    logger   *zap.Logger
)

// rootCmd represents the base command when called without any subcommands.
var rootCmd = &cobra.Command{
    Use:   "clustertool",
    Short: "Enterprise Kubernetes cluster management tool",
    Long: `clustertool manages Kubernetes clusters across multiple cloud providers.

Complete documentation is available at https://clustertool.example.com/docs`,
    // PersistentPreRunE runs before every subcommand, setting up logging and config.
    PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
        return initLogger()
    },
    // SilenceUsage prevents the usage message from printing on runtime errors.
    SilenceUsage: true,
    // SilenceErrors prevents duplicate error printing (cobra would print it,
    // but we handle it in main).
    SilenceErrors: true,
}

// Execute adds all child commands to the root command and sets flags appropriately.
func Execute() {
    if err := rootCmd.Execute(); err != nil {
        fmt.Fprintln(os.Stderr, err)
        os.Exit(1)
    }
}

func init() {
    cobra.OnInitialize(initConfig)

    // Persistent flags are available to this command and all subcommands.
    rootCmd.PersistentFlags().StringVar(&cfgFile, "config", "",
        "config file (default: $HOME/.clustertool/config.yaml)")
    rootCmd.PersistentFlags().StringVar(&logLevel, "log-level", "info",
        "Log level: debug, info, warn, error")
    rootCmd.PersistentFlags().StringVarP(&outFormat, "output", "o", "table",
        "Output format: table, json, yaml")

    // Bind flags to viper
    viper.BindPFlag("log-level", rootCmd.PersistentFlags().Lookup("log-level"))
    viper.BindPFlag("output", rootCmd.PersistentFlags().Lookup("output"))

    // Register subcommand groups
    rootCmd.AddCommand(cluster.NewClusterCmd())
    rootCmd.AddCommand(config.NewConfigCmd())
    rootCmd.AddCommand(newCompletionCmd())
}

func initConfig() {
    if cfgFile != "" {
        viper.SetConfigFile(cfgFile)
    } else {
        home, err := os.UserHomeDir()
        if err != nil {
            fmt.Fprintln(os.Stderr, "could not find home directory:", err)
            os.Exit(1)
        }
        configDir := filepath.Join(home, ".clustertool")
        viper.AddConfigPath(configDir)
        viper.SetConfigType("yaml")
        viper.SetConfigName("config")
    }

    // Environment variable prefix: CLUSTERTOOL_LOG_LEVEL, CLUSTERTOOL_OUTPUT, etc.
    viper.SetEnvPrefix("CLUSTERTOOL")
    viper.AutomaticEnv()

    if err := viper.ReadInConfig(); err != nil {
        if _, ok := err.(viper.ConfigFileNotFoundError); !ok {
            fmt.Fprintln(os.Stderr, "error reading config file:", err)
        }
        // Config file not found is acceptable; use defaults and env vars
    }
}

func initLogger() error {
    level, err := zapcore.ParseLevel(viper.GetString("log-level"))
    if err != nil {
        return fmt.Errorf("invalid log level %q: %w", viper.GetString("log-level"), err)
    }

    cfg := zap.NewProductionConfig()
    cfg.Level = zap.NewAtomicLevelAt(level)
    // Human-readable output when attached to a terminal
    if isTerminal() {
        cfg = zap.NewDevelopmentConfig()
        cfg.Level = zap.NewAtomicLevelAt(level)
    }

    logger, err = cfg.Build()
    if err != nil {
        return fmt.Errorf("building logger: %w", err)
    }

    return nil
}

func isTerminal() bool {
    fi, err := os.Stdout.Stat()
    if err != nil {
        return false
    }
    return (fi.Mode() & os.ModeCharDevice) != 0
}
```

### Cluster Subcommand Group

```go
// cmd/cluster/cluster.go
package cluster

import "github.com/spf13/cobra"

// NewClusterCmd creates the `cluster` subcommand group.
func NewClusterCmd() *cobra.Command {
    clusterCmd := &cobra.Command{
        Use:   "cluster",
        Short: "Manage Kubernetes clusters",
        Long:  "Create, list, delete, and manage Kubernetes clusters.",
    }

    clusterCmd.AddCommand(newCreateCmd())
    clusterCmd.AddCommand(newListCmd())
    clusterCmd.AddCommand(newDeleteCmd())

    return clusterCmd
}
```

### Cluster Create Command with Required Flags

```go
// cmd/cluster/create.go
package cluster

import (
    "context"
    "fmt"

    "github.com/spf13/cobra"
    "github.com/spf13/viper"

    "github.com/example/clustertool/internal/client"
    "github.com/example/clustertool/internal/output"
)

type createOptions struct {
    name       string
    region     string
    provider   string
    nodeCount  int
    nodeType   string
    k8sVersion string
    dryRun     bool
}

func newCreateCmd() *cobra.Command {
    opts := &createOptions{}

    cmd := &cobra.Command{
        Use:   "create NAME",
        Short: "Create a new Kubernetes cluster",
        Long: `Create a new Kubernetes cluster on the specified cloud provider.

Examples:
  # Create a cluster on AWS with 3 nodes
  clustertool cluster create my-cluster --provider aws --region us-east-1 --nodes 3

  # Create a cluster with a specific Kubernetes version
  clustertool cluster create prod-cluster --provider gcp --region us-central1 \
    --node-type n2-standard-4 --k8s-version 1.29.0

  # Dry run to see what would be created
  clustertool cluster create test-cluster --dry-run`,
        Args: cobra.ExactArgs(1),
        RunE: func(cmd *cobra.Command, args []string) error {
            opts.name = args[0]
            return runCreate(cmd.Context(), opts)
        },
    }

    // Local flags (only on this command)
    cmd.Flags().StringVar(&opts.region, "region", "", "Cloud provider region (required)")
    cmd.Flags().StringVar(&opts.provider, "provider", "", "Cloud provider: aws, gcp, azure (required)")
    cmd.Flags().IntVar(&opts.nodeCount, "nodes", 3, "Number of worker nodes")
    cmd.Flags().StringVar(&opts.nodeType, "node-type", "m5.xlarge",
        "Node instance type (provider-specific)")
    cmd.Flags().StringVar(&opts.k8sVersion, "k8s-version", "",
        "Kubernetes version (default: latest stable)")
    cmd.Flags().BoolVar(&opts.dryRun, "dry-run", false,
        "Show what would be created without making changes")

    // Mark required flags
    cmd.MarkFlagRequired("region")
    cmd.MarkFlagRequired("provider")

    // Register shell completion for --provider flag
    cmd.RegisterFlagCompletionFunc("provider", func(cmd *cobra.Command, args []string,
        toComplete string) ([]string, cobra.ShellCompDirective) {
        return []string{"aws", "gcp", "azure"}, cobra.ShellCompDirectiveNoFileComp
    })

    // Register shell completion for --region based on provider
    cmd.RegisterFlagCompletionFunc("region", func(cmd *cobra.Command, args []string,
        toComplete string) ([]string, cobra.ShellCompDirective) {
        provider, _ := cmd.Flags().GetString("provider")
        return getRegionsForProvider(provider), cobra.ShellCompDirectiveNoFileComp
    })

    return cmd
}

func runCreate(ctx context.Context, opts *createOptions) error {
    apiClient, err := client.NewFromConfig()
    if err != nil {
        return fmt.Errorf("initializing client: %w", err)
    }

    if opts.dryRun {
        fmt.Printf("Would create cluster:\n")
        fmt.Printf("  Name:        %s\n", opts.name)
        fmt.Printf("  Provider:    %s\n", opts.provider)
        fmt.Printf("  Region:      %s\n", opts.region)
        fmt.Printf("  Nodes:       %d x %s\n", opts.nodeCount, opts.nodeType)
        fmt.Printf("  K8s Version: %s\n", opts.k8sVersion)
        return nil
    }

    fmt.Printf("Creating cluster %q in %s (%s)...\n", opts.name, opts.region, opts.provider)

    cluster, err := apiClient.CreateCluster(ctx, client.CreateClusterRequest{
        Name:       opts.name,
        Provider:   opts.provider,
        Region:     opts.region,
        NodeCount:  opts.nodeCount,
        NodeType:   opts.nodeType,
        K8sVersion: opts.k8sVersion,
    })
    if err != nil {
        return fmt.Errorf("creating cluster: %w", err)
    }

    formatter := output.NewFormatter(viper.GetString("output"))
    return formatter.Print(cluster)
}

func getRegionsForProvider(provider string) []string {
    regions := map[string][]string{
        "aws":   {"us-east-1", "us-west-2", "eu-west-1", "ap-southeast-1"},
        "gcp":   {"us-central1", "us-east1", "europe-west1", "asia-east1"},
        "azure": {"eastus", "westus2", "westeurope", "southeastasia"},
    }
    if r, ok := regions[provider]; ok {
        return r
    }
    return nil
}
```

### Cluster List with Persistent Flags

```go
// cmd/cluster/list.go
package cluster

import (
    "context"
    "fmt"

    "github.com/spf13/cobra"
    "github.com/spf13/viper"

    "github.com/example/clustertool/internal/client"
    "github.com/example/clustertool/internal/output"
)

func newListCmd() *cobra.Command {
    var (
        provider string
        region   string
        status   string
    )

    cmd := &cobra.Command{
        Use:     "list",
        Aliases: []string{"ls"},
        Short:   "List clusters",
        RunE: func(cmd *cobra.Command, args []string) error {
            return runList(cmd.Context(), provider, region, status)
        },
    }

    cmd.Flags().StringVar(&provider, "provider", "", "Filter by provider")
    cmd.Flags().StringVar(&region, "region", "", "Filter by region")
    cmd.Flags().StringVar(&status, "status", "", "Filter by status: running, creating, error")

    cmd.RegisterFlagCompletionFunc("status", func(cmd *cobra.Command, args []string,
        toComplete string) ([]string, cobra.ShellCompDirective) {
        return []string{"running", "creating", "deleting", "error"}, cobra.ShellCompDirectiveNoFileComp
    })

    return cmd
}

func runList(ctx context.Context, provider, region, status string) error {
    apiClient, err := client.NewFromConfig()
    if err != nil {
        return fmt.Errorf("initializing client: %w", err)
    }

    clusters, err := apiClient.ListClusters(ctx, client.ListClustersRequest{
        Provider: provider,
        Region:   region,
        Status:   status,
    })
    if err != nil {
        return fmt.Errorf("listing clusters: %w", err)
    }

    formatter := output.NewFormatter(viper.GetString("output"))
    return formatter.Print(clusters)
}
```

## Section 2: viper for Multi-Source Configuration

### Configuration Binding Patterns

```go
// internal/config/config.go
package config

import (
    "fmt"
    "os"
    "path/filepath"

    "github.com/spf13/viper"
)

// AppConfig represents the full application configuration.
type AppConfig struct {
    // API connection
    APIEndpoint string `mapstructure:"api_endpoint"`
    APIToken    string `mapstructure:"api_token"`

    // TLS
    TLSCACert     string `mapstructure:"tls_ca_cert"`
    TLSClientCert string `mapstructure:"tls_client_cert"`
    TLSClientKey  string `mapstructure:"tls_client_key"`
    TLSInsecure   bool   `mapstructure:"tls_insecure"`

    // Behavior
    DefaultProvider string `mapstructure:"default_provider"`
    DefaultRegion   string `mapstructure:"default_region"`
    OutputFormat    string `mapstructure:"output"`
    PageSize        int    `mapstructure:"page_size"`

    // Context (active cluster)
    CurrentContext string `mapstructure:"current_context"`
}

// ConfigFilePath returns the path to the config file.
func ConfigFilePath() (string, error) {
    home, err := os.UserHomeDir()
    if err != nil {
        return "", err
    }
    return filepath.Join(home, ".clustertool", "config.yaml"), nil
}

// SetDefaults sets all default configuration values.
func SetDefaults() {
    viper.SetDefault("api_endpoint", "https://api.clustertool.example.com")
    viper.SetDefault("output", "table")
    viper.SetDefault("page_size", 50)
    viper.SetDefault("tls_insecure", false)
}

// Get returns the current application configuration.
// Priority (highest to lowest):
// 1. Flags (bound via viper.BindPFlag)
// 2. Environment variables (CLUSTERTOOL_API_ENDPOINT, etc.)
// 3. Config file (~/.clustertool/config.yaml)
// 4. Defaults
func Get() (*AppConfig, error) {
    var cfg AppConfig
    if err := viper.Unmarshal(&cfg); err != nil {
        return nil, fmt.Errorf("unmarshaling config: %w", err)
    }
    return &cfg, nil
}

// Save persists the configuration to disk.
func Save() error {
    configPath, err := ConfigFilePath()
    if err != nil {
        return err
    }

    if err := os.MkdirAll(filepath.Dir(configPath), 0700); err != nil {
        return fmt.Errorf("creating config directory: %w", err)
    }

    return viper.WriteConfigAs(configPath)
}
```

### Config Set/Get Commands

```go
// cmd/config/set.go
package config

import (
    "fmt"
    "strings"

    "github.com/spf13/cobra"
    "github.com/spf13/viper"

    internalcfg "github.com/example/clustertool/internal/config"
)

// validConfigKeys is the allowlist of settable configuration keys.
var validConfigKeys = map[string]string{
    "api-endpoint":       "API server endpoint",
    "api-token":          "API authentication token",
    "default-provider":   "Default cloud provider",
    "default-region":     "Default region",
    "output":             "Default output format",
    "tls-insecure":       "Skip TLS certificate verification (not recommended)",
}

func newSetCmd() *cobra.Command {
    cmd := &cobra.Command{
        Use:   "set KEY VALUE",
        Short: "Set a configuration value",
        Long: `Set a configuration value in the clustertool config file.

Valid keys:
` + formatValidKeys(),
        Args: cobra.ExactArgs(2),
        ValidArgsFunction: func(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
            if len(args) == 0 {
                keys := make([]string, 0, len(validConfigKeys))
                for k, desc := range validConfigKeys {
                    keys = append(keys, fmt.Sprintf("%s\t%s", k, desc))
                }
                return keys, cobra.ShellCompDirectiveNoFileComp
            }
            return nil, cobra.ShellCompDirectiveDefault
        },
        RunE: func(cmd *cobra.Command, args []string) error {
            key := args[0]
            value := args[1]

            // Normalize key (allow both - and _ separators)
            normalizedKey := strings.ReplaceAll(key, "-", "_")

            if _, ok := validConfigKeys[key]; !ok {
                return fmt.Errorf("unknown config key %q; valid keys: %v",
                    key, validKeyList())
            }

            viper.Set(normalizedKey, value)

            if err := internalcfg.Save(); err != nil {
                return fmt.Errorf("saving config: %w", err)
            }

            fmt.Printf("Set %s = %s\n", key, value)
            return nil
        },
    }
    return cmd
}

func newGetCmd() *cobra.Command {
    cmd := &cobra.Command{
        Use:   "get [KEY]",
        Short: "Get a configuration value or list all values",
        Args:  cobra.MaximumNArgs(1),
        RunE: func(cmd *cobra.Command, args []string) error {
            if len(args) == 0 {
                // Print all config
                settings := viper.AllSettings()
                for k, v := range settings {
                    fmt.Printf("%s = %v\n", k, v)
                }
                return nil
            }

            key := strings.ReplaceAll(args[0], "-", "_")
            val := viper.Get(key)
            if val == nil {
                return fmt.Errorf("config key %q is not set", args[0])
            }
            fmt.Printf("%v\n", val)
            return nil
        },
    }
    return cmd
}

func formatValidKeys() string {
    var sb strings.Builder
    for k, desc := range validConfigKeys {
        sb.WriteString(fmt.Sprintf("  %-20s %s\n", k, desc))
    }
    return sb.String()
}

func validKeyList() []string {
    keys := make([]string, 0, len(validConfigKeys))
    for k := range validConfigKeys {
        keys = append(keys, k)
    }
    return keys
}
```

### Binding Environment Variables with Viper

```go
// init() in root.go - comprehensive env var binding
func initConfig() {
    // ...

    // Explicit env var mappings for non-obvious names
    viper.BindEnv("api_token", "CLUSTERTOOL_API_TOKEN", "CT_TOKEN")
    viper.BindEnv("api_endpoint", "CLUSTERTOOL_API_ENDPOINT", "CT_API")

    // Set prefix - all CLUSTERTOOL_* vars are automatically bound
    viper.SetEnvPrefix("CLUSTERTOOL")
    // Replace - in key names with _ for env var matching
    viper.SetEnvKeyReplacer(strings.NewReplacer("-", "_", ".", "_"))
    viper.AutomaticEnv()

    // ...
}
```

## Section 3: survey for Interactive Prompts

### Interactive Cluster Creation Wizard

```go
// cmd/cluster/create_interactive.go
package cluster

import (
    "context"
    "fmt"

    "github.com/AlecAivazis/survey/v2"
    "github.com/spf13/cobra"
    "github.com/spf13/viper"

    "github.com/example/clustertool/internal/client"
    "github.com/example/clustertool/internal/output"
)

func newCreateInteractiveCmd() *cobra.Command {
    return &cobra.Command{
        Use:   "create-interactive",
        Short: "Create a cluster using an interactive wizard",
        RunE: func(cmd *cobra.Command, args []string) error {
            return runCreateInteractive(cmd.Context())
        },
    }
}

func runCreateInteractive(ctx context.Context) error {
    // Survey questions
    questions := []*survey.Question{
        {
            Name: "name",
            Prompt: &survey.Input{
                Message: "Cluster name:",
                Default: "my-cluster",
            },
            Validate: survey.ComposeValidators(
                survey.Required,
                survey.MinLength(3),
                survey.MaxLength(40),
                func(val interface{}) error {
                    name := val.(string)
                    for _, c := range name {
                        if !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-') {
                            return fmt.Errorf("name must contain only lowercase letters, digits, and hyphens")
                        }
                    }
                    return nil
                },
            ),
        },
        {
            Name: "provider",
            Prompt: &survey.Select{
                Message: "Cloud provider:",
                Options: []string{"aws", "gcp", "azure"},
                Default: viper.GetString("default_provider"),
                Description: func(value string, index int) string {
                    descriptions := map[string]string{
                        "aws":   "Amazon Web Services",
                        "gcp":   "Google Cloud Platform",
                        "azure": "Microsoft Azure",
                    }
                    return descriptions[value]
                },
            },
            Validate: survey.Required,
        },
        {
            Name: "region",
            Prompt: &survey.Select{
                Message: "Region:",
                Options: []string{}, // populated dynamically
            },
        },
        {
            Name: "nodeCount",
            Prompt: &survey.Input{
                Message: "Number of worker nodes:",
                Default: "3",
                Help:    "Minimum 1, recommended 3 for high availability",
            },
            Validate: survey.ComposeValidators(
                survey.Required,
                func(val interface{}) error {
                    n := 0
                    if _, err := fmt.Sscanf(val.(string), "%d", &n); err != nil {
                        return fmt.Errorf("must be a number")
                    }
                    if n < 1 || n > 100 {
                        return fmt.Errorf("must be between 1 and 100")
                    }
                    return nil
                },
            ),
        },
        {
            Name: "enableHA",
            Prompt: &survey.Confirm{
                Message: "Enable high-availability control plane?",
                Default: true,
                Help:    "HA requires 3 control plane nodes and increases cost",
            },
        },
    }

    // First, ask for provider to populate region options dynamically
    providerAnswer := struct{ Provider string }{}
    if err := survey.Ask([]*survey.Question{questions[1]}, &providerAnswer); err != nil {
        return fmt.Errorf("provider prompt: %w", err)
    }

    // Update region options based on selected provider
    regions := getRegionsForProvider(providerAnswer.Provider)
    questions[2].Prompt = &survey.Select{
        Message: "Region:",
        Options: regions,
        Default: viper.GetString("default_region"),
    }

    // Collect remaining answers
    answers := struct {
        Name      string
        Region    string
        NodeCount string
        EnableHA  bool
    }{}

    remainingQuestions := []*survey.Question{questions[0], questions[2], questions[3], questions[4]}
    if err := survey.Ask(remainingQuestions, &answers); err != nil {
        return fmt.Errorf("cluster configuration: %w", err)
    }

    // Parse node count
    var nodeCount int
    fmt.Sscanf(answers.NodeCount, "%d", &nodeCount)

    // Confirmation prompt
    summary := fmt.Sprintf(`
Creating cluster with:
  Name:     %s
  Provider: %s
  Region:   %s
  Nodes:    %d
  HA:       %v

`, answers.Name, providerAnswer.Provider, answers.Region, nodeCount, answers.EnableHA)

    fmt.Print(summary)

    confirmed := false
    if err := survey.AskOne(&survey.Confirm{
        Message: "Proceed with cluster creation?",
        Default: true,
    }, &confirmed); err != nil {
        return fmt.Errorf("confirmation prompt: %w", err)
    }

    if !confirmed {
        fmt.Println("Cluster creation cancelled.")
        return nil
    }

    // Create the cluster
    apiClient, err := client.NewFromConfig()
    if err != nil {
        return fmt.Errorf("initializing client: %w", err)
    }

    cluster, err := apiClient.CreateCluster(ctx, client.CreateClusterRequest{
        Name:      answers.Name,
        Provider:  providerAnswer.Provider,
        Region:    answers.Region,
        NodeCount: nodeCount,
        HighAvailability: answers.EnableHA,
    })
    if err != nil {
        return fmt.Errorf("creating cluster: %w", err)
    }

    formatter := output.NewFormatter(viper.GetString("output"))
    return formatter.Print(cluster)
}
```

### Password and Secret Prompts

```go
// Helper for sensitive input
func promptForToken(message string) (string, error) {
    var token string
    err := survey.AskOne(&survey.Password{
        Message: message,
        Help:    "Input is hidden and will not be echoed",
    }, &token, survey.WithValidator(survey.Required))
    return token, err
}

// Multi-select for bulk operations
func promptForClusters(clusters []string) ([]string, error) {
    selected := []string{}
    err := survey.AskOne(&survey.MultiSelect{
        Message:  "Select clusters to delete:",
        Options:  clusters,
        PageSize: 10,
    }, &selected, survey.WithValidator(survey.MinItems(1)))
    return selected, err
}

// Editor prompt for YAML configuration
func promptForYAML(defaultContent string) (string, error) {
    var content string
    err := survey.AskOne(&survey.Editor{
        Message:       "Edit cluster configuration:",
        Default:       defaultContent,
        HideDefault:   true,
        AppendDefault: true,
        FileName:      "*.yaml",
    }, &content)
    return content, err
}
```

## Section 4: Output Formatting

```go
// internal/output/formatter.go
package output

import (
    "encoding/json"
    "fmt"
    "io"
    "os"
    "reflect"

    "github.com/olekukonko/tablewriter"
    "gopkg.in/yaml.v3"
)

type Formatter struct {
    format string
    writer io.Writer
}

func NewFormatter(format string) *Formatter {
    return &Formatter{format: format, writer: os.Stdout}
}

func (f *Formatter) Print(v interface{}) error {
    switch f.format {
    case "json":
        return f.printJSON(v)
    case "yaml":
        return f.printYAML(v)
    case "table", "":
        return f.printTable(v)
    default:
        return fmt.Errorf("unsupported output format: %s", f.format)
    }
}

func (f *Formatter) printJSON(v interface{}) error {
    enc := json.NewEncoder(f.writer)
    enc.SetIndent("", "  ")
    return enc.Encode(v)
}

func (f *Formatter) printYAML(v interface{}) error {
    enc := yaml.NewEncoder(f.writer)
    enc.SetIndent(2)
    return enc.Encode(v)
}

// Tabular is implemented by types that know how to render themselves as tables.
type Tabular interface {
    Headers() []string
    Rows() [][]string
}

func (f *Formatter) printTable(v interface{}) error {
    if t, ok := v.(Tabular); ok {
        table := tablewriter.NewWriter(f.writer)
        table.SetHeader(t.Headers())
        table.SetBorder(false)
        table.SetHeaderLine(true)
        table.SetRowLine(false)
        table.SetColumnSeparator(" ")
        table.SetHeaderAlignment(tablewriter.ALIGN_LEFT)
        table.SetAlignment(tablewriter.ALIGN_LEFT)
        table.AppendBulk(t.Rows())
        table.Render()
        return nil
    }

    // Fallback to JSON for non-tabular types
    return f.printJSON(v)
}
```

### Making Domain Types Tabular

```go
// internal/client/cluster.go
package client

import (
    "fmt"
    "time"
)

type Cluster struct {
    ID         string    `json:"id" yaml:"id"`
    Name       string    `json:"name" yaml:"name"`
    Provider   string    `json:"provider" yaml:"provider"`
    Region     string    `json:"region" yaml:"region"`
    NodeCount  int       `json:"node_count" yaml:"node_count"`
    K8sVersion string    `json:"k8s_version" yaml:"k8s_version"`
    Status     string    `json:"status" yaml:"status"`
    CreatedAt  time.Time `json:"created_at" yaml:"created_at"`
    Endpoint   string    `json:"endpoint" yaml:"endpoint"`
}

type ClusterList struct {
    Clusters []Cluster `json:"clusters" yaml:"clusters"`
    Total    int       `json:"total" yaml:"total"`
}

// Headers implements output.Tabular
func (l ClusterList) Headers() []string {
    return []string{"NAME", "PROVIDER", "REGION", "NODES", "VERSION", "STATUS", "AGE"}
}

// Rows implements output.Tabular
func (l ClusterList) Rows() [][]string {
    rows := make([][]string, len(l.Clusters))
    for i, c := range l.Clusters {
        rows[i] = []string{
            c.Name,
            c.Provider,
            c.Region,
            fmt.Sprintf("%d", c.NodeCount),
            c.K8sVersion,
            colorizeStatus(c.Status),
            humanizeDuration(time.Since(c.CreatedAt)),
        }
    }
    return rows
}

func colorizeStatus(status string) string {
    switch status {
    case "running":
        return "\033[32m" + status + "\033[0m" // green
    case "error":
        return "\033[31m" + status + "\033[0m" // red
    case "creating", "deleting":
        return "\033[33m" + status + "\033[0m" // yellow
    default:
        return status
    }
}

func humanizeDuration(d time.Duration) string {
    if d < time.Minute {
        return fmt.Sprintf("%ds", int(d.Seconds()))
    }
    if d < time.Hour {
        return fmt.Sprintf("%dm", int(d.Minutes()))
    }
    if d < 24*time.Hour {
        return fmt.Sprintf("%dh", int(d.Hours()))
    }
    return fmt.Sprintf("%dd", int(d.Hours()/24))
}
```

## Section 5: Shell Completion Generation

```go
// cmd/completion.go
package cmd

import (
    "fmt"
    "os"

    "github.com/spf13/cobra"
)

func newCompletionCmd() *cobra.Command {
    completionCmd := &cobra.Command{
        Use:   "completion [bash|zsh|fish|powershell]",
        Short: "Generate shell completion scripts",
        Long: `Generate shell completion scripts for clustertool.

To load completions:

Bash:
  source <(clustertool completion bash)
  # For persistent completions:
  clustertool completion bash > /etc/bash_completion.d/clustertool

Zsh:
  source <(clustertool completion zsh)
  # For persistent completions:
  clustertool completion zsh > "${fpath[1]}/_clustertool"

Fish:
  clustertool completion fish | source
  # For persistent completions:
  clustertool completion fish > ~/.config/fish/completions/clustertool.fish

PowerShell:
  clustertool completion powershell | Out-String | Invoke-Expression
  # For persistent completions, add the above to your $PROFILE.
`,
        DisableFlagsInUseLine: true,
        ValidArgs:             []string{"bash", "zsh", "fish", "powershell"},
        Args:                  cobra.MatchAll(cobra.ExactArgs(1), cobra.OnlyValidArgs),
        RunE: func(cmd *cobra.Command, args []string) error {
            switch args[0] {
            case "bash":
                return rootCmd.GenBashCompletionV2(os.Stdout, true)
            case "zsh":
                return rootCmd.GenZshCompletion(os.Stdout)
            case "fish":
                return rootCmd.GenFishCompletion(os.Stdout, true)
            case "powershell":
                return rootCmd.GenPowerShellCompletionWithDesc(os.Stdout)
            default:
                return fmt.Errorf("unsupported shell: %s", args[0])
            }
        },
    }
    return completionCmd
}
```

## Section 6: GoReleaser for Distribution

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
      - windows
      - darwin
    goarch:
      - amd64
      - arm64
    ldflags:
      - -s -w
      - -X main.version={{.Version}}
      - -X main.commit={{.Commit}}
      - -X main.date={{.Date}}
      - -X main.builtBy=goreleaser
    binary: clustertool

archives:
  - format: tar.gz
    name_template: >-
      {{.ProjectName}}_{{.Version}}_
      {{- title .Os }}_
      {{- if eq .Arch "amd64"}}x86_64
      {{- else if eq .Arch "386"}}i386
      {{- else}}{{ .Arch }}{{ end }}
      {{- if .Arm}}v{{ .Arm }}{{ end }}
    format_overrides:
      - goos: windows
        format: zip
    files:
      - README.md
      - LICENSE
      - completions/*

checksum:
  name_template: checksums.txt

changelog:
  sort: asc
  filters:
    exclude:
      - "^docs:"
      - "^test:"
      - "^chore:"
  groups:
    - title: Features
      regexp: "^feat"
      order: 0
    - title: Bug Fixes
      regexp: "^fix"
      order: 1
    - title: Other
      order: 999

brews:
  - repository:
      owner: myorg
      name: homebrew-tap
      token: "{{ .Env.HOMEBREW_TAP_TOKEN }}"
    directory: Formula
    homepage: https://clustertool.example.com
    description: Enterprise Kubernetes cluster management tool
    license: Apache-2.0
    install: |
      bin.install "clustertool"
      bash_completion.install "completions/clustertool.bash" => "clustertool"
      zsh_completion.install "completions/clustertool.zsh" => "_clustertool"
      fish_completion.install "completions/clustertool.fish"
    test: |
      system "#{bin}/clustertool", "--version"

nfpms:
  - package_name: clustertool
    homepage: https://clustertool.example.com
    description: Enterprise Kubernetes cluster management tool
    license: Apache-2.0
    formats:
      - deb
      - rpm
    contents:
      - src: completions/clustertool.bash
        dst: /usr/share/bash-completion/completions/clustertool
      - src: completions/clustertool.zsh
        dst: /usr/share/zsh/vendor-completions/_clustertool
      - src: completions/clustertool.fish
        dst: /usr/share/fish/completions/clustertool.fish

dockers:
  - image_templates:
      - "ghcr.io/myorg/clustertool:{{ .Tag }}-amd64"
      - "ghcr.io/myorg/clustertool:latest-amd64"
    dockerfile: Dockerfile
    use: buildx
    build_flag_templates:
      - "--platform=linux/amd64"
      - "--label=org.opencontainers.image.title={{.ProjectName}}"
      - "--label=org.opencontainers.image.version={{.Version}}"
  - image_templates:
      - "ghcr.io/myorg/clustertool:{{ .Tag }}-arm64v8"
      - "ghcr.io/myorg/clustertool:latest-arm64v8"
    dockerfile: Dockerfile
    use: buildx
    goarch: arm64
    build_flag_templates:
      - "--platform=linux/arm64/v8"

docker_manifests:
  - name_template: "ghcr.io/myorg/clustertool:{{ .Tag }}"
    image_templates:
      - "ghcr.io/myorg/clustertool:{{ .Tag }}-amd64"
      - "ghcr.io/myorg/clustertool:{{ .Tag }}-arm64v8"
```

### Version Information Injection

```go
// main.go
package main

import (
    "fmt"
    "runtime"

    "github.com/spf13/cobra"

    "github.com/example/clustertool/cmd"
)

// Set by goreleaser via -ldflags
var (
    version = "dev"
    commit  = "none"
    date    = "unknown"
    builtBy = "local"
)

func main() {
    cmd.SetVersionInfo(version, commit, date, builtBy)
    cmd.Execute()
}
```

```go
// cmd/version.go
package cmd

import (
    "fmt"
    "runtime"

    "github.com/spf13/cobra"
)

var versionInfo struct {
    Version string
    Commit  string
    Date    string
    BuiltBy string
}

func SetVersionInfo(version, commit, date, builtBy string) {
    versionInfo.Version = version
    versionInfo.Commit = commit
    versionInfo.Date = date
    versionInfo.BuiltBy = builtBy
}

func init() {
    rootCmd.AddCommand(&cobra.Command{
        Use:   "version",
        Short: "Print version information",
        Run: func(cmd *cobra.Command, args []string) {
            fmt.Printf("clustertool version %s\n", versionInfo.Version)
            fmt.Printf("  Commit:  %s\n", versionInfo.Commit)
            fmt.Printf("  Built:   %s\n", versionInfo.Date)
            fmt.Printf("  By:      %s\n", versionInfo.BuiltBy)
            fmt.Printf("  Go:      %s\n", runtime.Version())
            fmt.Printf("  OS/Arch: %s/%s\n", runtime.GOOS, runtime.GOARCH)
        },
    })
}
```

### Generating Shell Completions at Build Time

```makefile
# Makefile
.PHONY: completions
completions: build
	mkdir -p completions
	./bin/clustertool completion bash > completions/clustertool.bash
	./bin/clustertool completion zsh > completions/clustertool.zsh
	./bin/clustertool completion fish > completions/clustertool.fish
	./bin/clustertool completion powershell > completions/clustertool.ps1

.PHONY: release
release: completions
	goreleaser release --clean

.PHONY: release-snapshot
release-snapshot: completions
	goreleaser release --snapshot --clean
```

## Conclusion

The cobra + viper + survey combination covers the full spectrum of CLI needs: cobra provides the command hierarchy and shell completion framework, viper unifies configuration from files, environment variables, and flags with clear priority ordering, and survey delivers polished interactive user experiences. GoReleaser automates cross-platform distribution, Homebrew taps, deb/rpm packages, and container images from a single configuration file. Enterprise CLI tools built on these foundations are discoverable through shell completion, configurable through multiple mechanisms, and distributable through all major package managers.
