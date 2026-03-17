---
title: "Go CLI Tools: cobra, viper, and Building Enterprise Command-Line Applications"
date: 2030-03-19T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "cobra", "viper", "CLI", "DevOps Tools", "Command Line"]
categories: ["Go", "Developer Tools"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Building production CLIs with cobra and viper: config file hierarchies, environment variable binding, shell completion generation, plugin systems, and enterprise patterns for Kubernetes-style operator tools."
more_link: "yes"
url: "/go-cli-tools-cobra-viper-enterprise-command-line-applications/"
---

The command-line interface is the primary interaction surface for DevOps and platform engineering tools. kubectl, helm, terraform, and istioctl all demonstrate what production-quality CLIs look like: consistent flag conventions, rich shell completion, layered configuration, and extensible plugin architectures. Building CLIs of this caliber in Go requires mastering cobra for command structure and viper for configuration management, then layering in patterns for testability, plugin systems, and multi-environment deployment.

This guide covers the complete spectrum of enterprise CLI development with cobra and viper: from project structure through to shell completion generation, plugin systems, and testing strategies for complex command hierarchies.

<!--more-->

## Project Structure for Enterprise CLIs

A production CLI requires a well-organized directory structure that separates concerns and enables independent testing of command logic:

```
myctl/
├── cmd/
│   ├── root.go              # Root command, global flags, viper setup
│   ├── version.go           # Version command
│   ├── get/
│   │   ├── get.go           # get parent command
│   │   ├── get_users.go     # get users subcommand
│   │   └── get_clusters.go  # get clusters subcommand
│   ├── create/
│   │   ├── create.go
│   │   └── create_user.go
│   ├── delete/
│   │   └── delete.go
│   └── config/
│       ├── config.go
│       ├── config_view.go
│       └── config_set.go
├── pkg/
│   ├── client/              # API client
│   ├── output/              # Output formatters (table, json, yaml)
│   ├── config/              # Config file management
│   └── completion/          # Completion helper functions
├── internal/
│   └── testutil/            # Test utilities
├── plugins/                 # Plugin interface definitions
├── main.go
├── go.mod
└── go.sum
```

## The Root Command: Foundation of the CLI

The root command initializes viper, sets global flags, and registers subcommands:

```go
// cmd/root.go
package cmd

import (
    "fmt"
    "os"
    "path/filepath"
    "strings"

    "github.com/spf13/cobra"
    "github.com/spf13/viper"
    "go.uber.org/zap"
)

var (
    cfgFile string
    logger  *zap.Logger
)

// rootCmd represents the base command
var rootCmd = &cobra.Command{
    Use:   "myctl",
    Short: "myctl - Enterprise platform management CLI",
    Long: `myctl is a command-line tool for managing enterprise platform resources.

It provides commands for managing users, clusters, deployments, and configurations
across multiple environments with full audit logging.

Configuration precedence (highest to lowest):
  1. Command-line flags
  2. Environment variables (MYCTL_*)
  3. Config file (~/.myctl/config.yaml)
  4. Default values

Documentation: https://docs.mycompany.com/myctl`,
    PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
        return initLogging()
    },
    SilenceUsage:  true, // Don't print usage on error
    SilenceErrors: true, // Handle errors ourselves
}

// Execute is the main entry point
func Execute() {
    if err := rootCmd.Execute(); err != nil {
        fmt.Fprintf(os.Stderr, "Error: %v\n", err)
        os.Exit(1)
    }
}

func init() {
    cobra.OnInitialize(initConfig)

    // Global persistent flags (available on all subcommands)
    rootCmd.PersistentFlags().StringVar(&cfgFile, "config", "",
        "config file (default: ~/.myctl/config.yaml)")
    rootCmd.PersistentFlags().StringP("output", "o", "table",
        "output format: table, json, yaml, wide")
    rootCmd.PersistentFlags().StringP("context", "c", "",
        "context to use (overrides current-context in config)")
    rootCmd.PersistentFlags().BoolP("verbose", "v", false,
        "enable verbose output")
    rootCmd.PersistentFlags().Bool("no-color", false,
        "disable colored output")
    rootCmd.PersistentFlags().DurationP("timeout", "t", 30*time.Second,
        "timeout for API operations")

    // Bind all persistent flags to viper
    viper.BindPFlag("output", rootCmd.PersistentFlags().Lookup("output"))
    viper.BindPFlag("context", rootCmd.PersistentFlags().Lookup("context"))
    viper.BindPFlag("verbose", rootCmd.PersistentFlags().Lookup("verbose"))
    viper.BindPFlag("no-color", rootCmd.PersistentFlags().Lookup("no-color"))
    viper.BindPFlag("timeout", rootCmd.PersistentFlags().Lookup("timeout"))

    // Register subcommands
    rootCmd.AddCommand(newGetCmd())
    rootCmd.AddCommand(newCreateCmd())
    rootCmd.AddCommand(newDeleteCmd())
    rootCmd.AddCommand(newConfigCmd())
    rootCmd.AddCommand(newVersionCmd())
    rootCmd.AddCommand(newCompletionCmd())
}

// initConfig sets up viper configuration
func initConfig() {
    if cfgFile != "" {
        // Use config file from the flag
        viper.SetConfigFile(cfgFile)
    } else {
        // Find home directory
        home, err := os.UserHomeDir()
        cobra.CheckErr(err)

        // Search for config in multiple locations (precedence order)
        viper.AddConfigPath(filepath.Join(home, ".myctl"))  // ~/.myctl/
        viper.AddConfigPath(".")                             // Current directory
        viper.AddConfigPath("/etc/myctl")                   // System-wide

        viper.SetConfigType("yaml")
        viper.SetConfigName("config")
    }

    // Environment variable configuration
    viper.SetEnvPrefix("MYCTL")  // Looks for MYCTL_* env vars
    viper.SetEnvKeyReplacer(strings.NewReplacer(".", "_", "-", "_"))
    viper.AutomaticEnv()

    // Read in environment variables that match
    // MYCTL_OUTPUT=json is equivalent to --output=json

    if err := viper.ReadInConfig(); err != nil {
        if _, ok := err.(viper.ConfigFileNotFoundError); !ok {
            // Config file found but had errors
            fmt.Fprintf(os.Stderr, "Error reading config file: %v\n", err)
        }
        // Config file not found: use defaults and env vars
    }
}

func initLogging() error {
    var cfg zap.Config
    if viper.GetBool("verbose") {
        cfg = zap.NewDevelopmentConfig()
    } else {
        cfg = zap.NewProductionConfig()
        cfg.Level = zap.NewAtomicLevelAt(zap.WarnLevel)
    }

    var err error
    logger, err = cfg.Build()
    if err != nil {
        return fmt.Errorf("initializing logger: %w", err)
    }
    return nil
}
```

## Configuration File Hierarchy with Viper

Viper supports multi-level configuration that mirrors kubectl's kubeconfig pattern:

```go
// pkg/config/config.go
package config

import (
    "fmt"
    "os"
    "path/filepath"

    "github.com/spf13/viper"
    "gopkg.in/yaml.v3"
)

// Config represents the CLI configuration file structure
type Config struct {
    APIVersion     string             `yaml:"apiVersion" mapstructure:"apiVersion"`
    Kind           string             `yaml:"kind" mapstructure:"kind"`
    CurrentContext string             `yaml:"current-context" mapstructure:"current-context"`
    Contexts       []NamedContext     `yaml:"contexts" mapstructure:"contexts"`
    Clusters       []NamedCluster     `yaml:"clusters" mapstructure:"clusters"`
    Users          []NamedUser        `yaml:"users" mapstructure:"users"`
    Preferences    Preferences        `yaml:"preferences" mapstructure:"preferences"`
}

type NamedContext struct {
    Name    string  `yaml:"name" mapstructure:"name"`
    Context Context `yaml:"context" mapstructure:"context"`
}

type Context struct {
    Cluster   string `yaml:"cluster" mapstructure:"cluster"`
    User      string `yaml:"user" mapstructure:"user"`
    Namespace string `yaml:"namespace" mapstructure:"namespace"`
}

type NamedCluster struct {
    Name    string  `yaml:"name" mapstructure:"name"`
    Cluster Cluster `yaml:"cluster" mapstructure:"cluster"`
}

type Cluster struct {
    Server                   string `yaml:"server" mapstructure:"server"`
    InsecureSkipTLSVerify    bool   `yaml:"insecure-skip-tls-verify" mapstructure:"insecure-skip-tls-verify"`
    CertificateAuthorityData string `yaml:"certificate-authority-data" mapstructure:"certificate-authority-data"`
}

type NamedUser struct {
    Name string `yaml:"name" mapstructure:"name"`
    User User   `yaml:"user" mapstructure:"user"`
}

type User struct {
    Token            string `yaml:"token" mapstructure:"token"`
    ClientCertData   string `yaml:"client-certificate-data" mapstructure:"client-certificate-data"`
    ClientKeyData    string `yaml:"client-key-data" mapstructure:"client-key-data"`
    ExecProvider     *ExecConfig `yaml:"exec,omitempty" mapstructure:"exec"`
}

type ExecConfig struct {
    APIVersion  string            `yaml:"apiVersion" mapstructure:"apiVersion"`
    Command     string            `yaml:"command" mapstructure:"command"`
    Args        []string          `yaml:"args" mapstructure:"args"`
    Env         []EnvVar          `yaml:"env" mapstructure:"env"`
    ProvideClusterInfo bool       `yaml:"provideClusterInfo" mapstructure:"provideClusterInfo"`
}

type EnvVar struct {
    Name  string `yaml:"name" mapstructure:"name"`
    Value string `yaml:"value" mapstructure:"value"`
}

type Preferences struct {
    Colors bool   `yaml:"colors" mapstructure:"colors"`
    Output string `yaml:"output" mapstructure:"output"`
}

// ConfigManager handles loading, saving, and merging configs
type ConfigManager struct {
    paths  []string
    config *Config
}

// NewConfigManager creates a manager that merges configs from multiple paths
func NewConfigManager() *ConfigManager {
    home, _ := os.UserHomeDir()

    // Config search path (precedence: first found wins for current-context)
    paths := []string{
        filepath.Join(home, ".myctl", "config.yaml"),
    }

    // Support MYCTL_CONFIG env var for overriding config path
    if envConfig := os.Getenv("MYCTL_CONFIG"); envConfig != "" {
        paths = filepath.SplitList(envConfig)
    }

    return &ConfigManager{paths: paths}
}

func (cm *ConfigManager) Load() (*Config, error) {
    merged := &Config{
        APIVersion: "v1",
        Kind:       "Config",
    }

    for _, path := range cm.paths {
        data, err := os.ReadFile(path)
        if os.IsNotExist(err) {
            continue
        }
        if err != nil {
            return nil, fmt.Errorf("reading config %s: %w", path, err)
        }

        cfg := &Config{}
        if err := yaml.Unmarshal(data, cfg); err != nil {
            return nil, fmt.Errorf("parsing config %s: %w", path, err)
        }

        // Merge: append contexts, clusters, users
        merged.Contexts = append(merged.Contexts, cfg.Contexts...)
        merged.Clusters = append(merged.Clusters, cfg.Clusters...)
        merged.Users = append(merged.Users, cfg.Users...)

        // First config with a current-context wins
        if merged.CurrentContext == "" && cfg.CurrentContext != "" {
            merged.CurrentContext = cfg.CurrentContext
        }
    }

    cm.config = merged
    return merged, nil
}

func (cm *ConfigManager) Save(cfg *Config) error {
    if len(cm.paths) == 0 {
        return fmt.Errorf("no config path configured")
    }

    path := cm.paths[0]
    if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
        return fmt.Errorf("creating config directory: %w", err)
    }

    data, err := yaml.Marshal(cfg)
    if err != nil {
        return fmt.Errorf("serializing config: %w", err)
    }

    if err := os.WriteFile(path, data, 0600); err != nil {
        return fmt.Errorf("writing config: %w", err)
    }

    return nil
}
```

## Building a Complete Command with Viper Binding

Here is a production-quality `get users` command with full viper integration:

```go
// cmd/get/get_users.go
package get

import (
    "fmt"
    "strings"
    "time"

    "github.com/spf13/cobra"
    "github.com/spf13/viper"

    "myctl/pkg/client"
    "myctl/pkg/output"
)

func newGetUsersCmd() *cobra.Command {
    cmd := &cobra.Command{
        Use:     "users [USER_NAME...]",
        Aliases: []string{"user", "u"},
        Short:   "List or get users",
        Long: `Display one or many users.

Examples:
  # List all users
  myctl get users

  # List users in JSON format
  myctl get users -o json

  # Get a specific user
  myctl get users john.doe

  # Filter by status
  myctl get users --status=active

  # Watch for changes
  myctl get users --watch`,

        // ValidArgsFunction enables shell completion for positional arguments
        ValidArgsFunction: func(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
            // Dynamic completion: fetch user names from API
            apiClient, err := client.NewFromContext(viper.GetString("context"))
            if err != nil {
                return nil, cobra.ShellCompDirectiveError
            }
            users, err := apiClient.Users().List(cmd.Context())
            if err != nil {
                return nil, cobra.ShellCompDirectiveError
            }

            var completions []string
            for _, u := range users {
                if strings.HasPrefix(u.Name, toComplete) {
                    completions = append(completions,
                        fmt.Sprintf("%s\t%s", u.Name, u.Email))
                }
            }
            return completions, cobra.ShellCompDirectiveNoFileComp
        },

        RunE: func(cmd *cobra.Command, args []string) error {
            return runGetUsers(cmd, args)
        },
    }

    // Command-specific flags
    cmd.Flags().StringSlice("status", nil,
        "filter by status (active, inactive, pending)")
    cmd.Flags().StringSlice("role", nil,
        "filter by role (admin, user, viewer)")
    cmd.Flags().String("sort-by", "name",
        "sort by field (name, email, created-at, last-login)")
    cmd.Flags().BoolP("watch", "w", false,
        "watch for changes")
    cmd.Flags().String("label-selector", "",
        "filter by label selector (key=value)")
    cmd.Flags().Int("limit", 100,
        "maximum number of results to return")

    // Bind command flags to viper (namespaced to avoid conflicts)
    viper.BindPFlag("get.users.status", cmd.Flags().Lookup("status"))
    viper.BindPFlag("get.users.sort-by", cmd.Flags().Lookup("sort-by"))
    viper.BindPFlag("get.users.limit", cmd.Flags().Lookup("limit"))

    // Register completion for flag values
    cmd.RegisterFlagCompletionFunc("status", func(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
        return []string{"active", "inactive", "pending"}, cobra.ShellCompDirectiveNoFileComp
    })
    cmd.RegisterFlagCompletionFunc("sort-by", func(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
        return []string{"name", "email", "created-at", "last-login"}, cobra.ShellCompDirectiveNoFileComp
    })
    cmd.RegisterFlagCompletionFunc("output", func(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
        return []string{"table", "json", "yaml", "wide"}, cobra.ShellCompDirectiveNoFileComp
    })

    return cmd
}

func runGetUsers(cmd *cobra.Command, args []string) error {
    ctx := cmd.Context()
    timeout := viper.GetDuration("timeout")
    ctx, cancel := context.WithTimeout(ctx, timeout)
    defer cancel()

    apiClient, err := client.NewFromContext(viper.GetString("context"))
    if err != nil {
        return fmt.Errorf("creating API client: %w", err)
    }

    outputFormat := viper.GetString("output")
    watch, _ := cmd.Flags().GetBool("watch")
    status, _ := cmd.Flags().GetStringSlice("status")
    roles, _ := cmd.Flags().GetStringSlice("role")
    limit, _ := cmd.Flags().GetInt("limit")

    if len(args) > 0 {
        // Get specific users
        users := make([]*User, 0, len(args))
        for _, name := range args {
            user, err := apiClient.Users().Get(ctx, name)
            if err != nil {
                return fmt.Errorf("getting user %s: %w", name, err)
            }
            users = append(users, user)
        }
        return output.Print(users, outputFormat)
    }

    if watch {
        return watchUsers(ctx, apiClient, outputFormat)
    }

    opts := &client.ListUsersOptions{
        StatusFilter: status,
        RoleFilter:   roles,
        Limit:        limit,
    }

    users, err := apiClient.Users().List(ctx, opts)
    if err != nil {
        return fmt.Errorf("listing users: %w", err)
    }

    return output.Print(users, outputFormat)
}
```

## Shell Completion Generation

Shell completion is a first-class feature for production CLIs. Cobra generates completion scripts for bash, zsh, fish, and PowerShell:

```go
// cmd/completion.go
package cmd

import (
    "os"

    "github.com/spf13/cobra"
)

func newCompletionCmd() *cobra.Command {
    cmd := &cobra.Command{
        Use:   "completion [bash|zsh|fish|powershell]",
        Short: "Generate shell completion scripts",
        Long: `Generate shell completion scripts for myctl.

To load bash completions:
  # One-time setup
  source <(myctl completion bash)

  # Permanent setup
  myctl completion bash > /etc/bash_completion.d/myctl

  # Or for a single user
  myctl completion bash > ~/.bash_completion.d/myctl.sh
  echo 'source ~/.bash_completion.d/myctl.sh' >> ~/.bashrc

To load zsh completions:
  # One-time setup
  source <(myctl completion zsh)

  # Enable zsh completions if not already enabled
  echo "autoload -U compinit; compinit" >> ~/.zshrc

  # Permanent setup (recommended)
  myctl completion zsh > "${fpath[1]}/_myctl"

  # Or with brew on macOS
  myctl completion zsh > $(brew --prefix)/share/zsh/site-functions/_myctl

To load fish completions:
  myctl completion fish | source

  # Or permanently
  myctl completion fish > ~/.config/fish/completions/myctl.fish`,
        ValidArgs: []string{"bash", "zsh", "fish", "powershell"},
        Args:      cobra.ExactArgs(1),
        RunE: func(cmd *cobra.Command, args []string) error {
            switch args[0] {
            case "bash":
                return rootCmd.GenBashCompletionV2(os.Stdout, true)
            case "zsh":
                return rootCmd.GenZshCompletion(os.Stdout)
            case "fish":
                return rootCmd.GenFishCompletion(os.Stdout, true)
            case "powershell":
                return rootCmd.GenPowerShellCompletion(os.Stdout)
            default:
                return fmt.Errorf("unknown shell: %s", args[0])
            }
        },
    }
    return cmd
}
```

### Dynamic Completion for Kubernetes Resources

For CLIs that interact with Kubernetes, implement dynamic completion that queries the cluster:

```go
// pkg/completion/k8s_completions.go
package completion

import (
    "context"
    "strings"

    "github.com/spf13/cobra"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/client-go/kubernetes"
)

// NamespaceCompletionFunc returns completion for namespace names
func NamespaceCompletionFunc(clientset *kubernetes.Clientset) cobra.CompletionFunc {
    return func(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
        ctx, cancel := context.WithTimeout(cmd.Context(), 5*time.Second)
        defer cancel()

        namespaces, err := clientset.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
        if err != nil {
            return nil, cobra.ShellCompDirectiveError
        }

        var completions []string
        for _, ns := range namespaces.Items {
            if strings.HasPrefix(ns.Name, toComplete) {
                // Add description after tab
                completions = append(completions,
                    fmt.Sprintf("%s\t%s", ns.Name, ns.Status.Phase))
            }
        }
        return completions, cobra.ShellCompDirectiveNoFileComp
    }
}

// PodCompletionFunc returns completion for pod names in a namespace
func PodCompletionFunc(clientset *kubernetes.Clientset, getNamespace func() string) cobra.CompletionFunc {
    return func(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
        ctx, cancel := context.WithTimeout(cmd.Context(), 5*time.Second)
        defer cancel()

        namespace := getNamespace()
        if namespace == "" {
            namespace = "default"
        }

        pods, err := clientset.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{})
        if err != nil {
            return nil, cobra.ShellCompDirectiveError
        }

        var completions []string
        for _, pod := range pods.Items {
            if strings.HasPrefix(pod.Name, toComplete) {
                status := string(pod.Status.Phase)
                completions = append(completions,
                    fmt.Sprintf("%s\t%s/%s", pod.Name, pod.Namespace, status))
            }
        }
        return completions, cobra.ShellCompDirectiveNoFileComp
    }
}
```

## Plugin System Architecture

A plugin system allows teams to extend the CLI without modifying the core binary. kubectl's plugin mechanism is the reference implementation:

```go
// plugins/plugin.go
package plugins

import (
    "fmt"
    "os"
    "os/exec"
    "path/filepath"
    "strings"

    "github.com/spf13/cobra"
)

// PluginManager discovers and executes CLI plugins
type PluginManager struct {
    // Directories to search for plugins
    searchPaths []string
    // Plugin name prefix (e.g., "myctl-" for "myctl-foo" plugin)
    prefix string
}

// NewPluginManager creates a plugin manager
func NewPluginManager(prefix string) *PluginManager {
    paths := []string{}

    // Add directories from PATH
    if pathEnv := os.Getenv("PATH"); pathEnv != "" {
        paths = append(paths, filepath.SplitList(pathEnv)...)
    }

    // Add plugin-specific directories
    home, _ := os.UserHomeDir()
    paths = append(paths,
        filepath.Join(home, ".myctl", "plugins"),
        "/usr/local/lib/myctl/plugins",
    )

    // Support MYCTL_PLUGIN_PATH override
    if pluginPath := os.Getenv("MYCTL_PLUGIN_PATH"); pluginPath != "" {
        paths = append(filepath.SplitList(pluginPath), paths...)
    }

    return &PluginManager{
        searchPaths: paths,
        prefix:      prefix,
    }
}

// Discover finds all installed plugins
func (pm *PluginManager) Discover() ([]Plugin, error) {
    seen := map[string]bool{}
    var plugins []Plugin

    for _, dir := range pm.searchPaths {
        entries, err := os.ReadDir(dir)
        if os.IsNotExist(err) {
            continue
        }
        if err != nil {
            continue
        }

        for _, entry := range entries {
            if entry.IsDir() {
                continue
            }

            name := entry.Name()
            if !strings.HasPrefix(name, pm.prefix) {
                continue
            }

            // Strip OS-specific extensions
            pluginName := strings.TrimSuffix(name, ".exe")
            if seen[pluginName] {
                continue
            }
            seen[pluginName] = true

            fullPath := filepath.Join(dir, name)
            info, err := entry.Info()
            if err != nil {
                continue
            }

            // Check if executable
            if info.Mode()&0111 == 0 {
                continue
            }

            // Derive cobra command name from plugin name
            // "myctl-get-users" -> command "get users"
            cmdName := strings.TrimPrefix(pluginName, pm.prefix)
            cmdName = strings.ReplaceAll(cmdName, "-", " ")

            plugins = append(plugins, Plugin{
                Name:    pluginName,
                Path:    fullPath,
                Command: cmdName,
            })
        }
    }

    return plugins, nil
}

// Plugin represents a discovered plugin
type Plugin struct {
    Name    string
    Path    string
    Command string
}

// Execute runs the plugin with the given arguments
func (p *Plugin) Execute(args []string) error {
    cmd := exec.Command(p.Path, args...)
    cmd.Stdin = os.Stdin
    cmd.Stdout = os.Stdout
    cmd.Stderr = os.Stderr

    // Pass environment context to plugin
    cmd.Env = append(os.Environ(),
        "MYCTL_PLUGIN=1",
        "MYCTL_VERSION="+version,
    )

    if err := cmd.Run(); err != nil {
        if exitErr, ok := err.(*exec.ExitError); ok {
            os.Exit(exitErr.ExitCode())
        }
        return fmt.Errorf("plugin execution failed: %w", err)
    }
    return nil
}

// RegisterPluginsWithCobra adds discovered plugins as cobra commands
func RegisterPluginsWithCobra(root *cobra.Command, pm *PluginManager) error {
    plugins, err := pm.Discover()
    if err != nil {
        return fmt.Errorf("discovering plugins: %w", err)
    }

    for _, plugin := range plugins {
        plugin := plugin // capture range variable

        // Create a cobra command for each plugin
        cmd := &cobra.Command{
            Use:                plugin.Command,
            Short:              fmt.Sprintf("External plugin: %s", plugin.Name),
            DisableFlagParsing: true, // Pass all flags to the plugin
            RunE: func(cmd *cobra.Command, args []string) error {
                return plugin.Execute(args)
            },
        }

        // Add as subcommand of root
        root.AddCommand(cmd)
    }

    return nil
}
```

### Writing a Compatible Plugin

Plugins must follow the naming convention and accept standard environment variables:

```bash
#!/bin/bash
# ~/.myctl/plugins/myctl-audit
# Plugin: audit - retrieve audit logs

set -euo pipefail

# Check that we're running as a myctl plugin
if [[ -z "${MYCTL_PLUGIN:-}" ]]; then
    echo "This binary is a myctl plugin and must be run through myctl" >&2
    exit 1
fi

# Parse arguments
NAMESPACE=""
OUTPUT="table"
SINCE="1h"

while [[ $# -gt 0 ]]; do
    case $1 in
        -n|--namespace)
            NAMESPACE="$2"
            shift 2
            ;;
        -o|--output)
            OUTPUT="$2"
            shift 2
            ;;
        --since)
            SINCE="$2"
            shift 2
            ;;
        *)
            echo "Unknown argument: $1" >&2
            exit 1
            ;;
    esac
done

# Use environment variables from myctl
CONTEXT="${MYCTL_CONTEXT:-default}"
API_URL="${MYCTL_API_URL:-http://localhost:8080}"

# Fetch and display audit logs
curl -sf \
  -H "Authorization: Bearer ${MYCTL_TOKEN:-}" \
  "${API_URL}/api/v1/audit?namespace=${NAMESPACE}&since=${SINCE}" | \
  jq -r '.[] | "\(.timestamp) \(.user) \(.action) \(.resource)"'
```

## Output Formatting System

A production CLI must support multiple output formats (table, JSON, YAML, wide):

```go
// pkg/output/output.go
package output

import (
    "encoding/json"
    "fmt"
    "io"
    "os"
    "reflect"
    "text/tabwriter"

    "gopkg.in/yaml.v3"
)

// Printer handles output formatting
type Printer struct {
    writer io.Writer
    format string
    noColor bool
}

// NewPrinter creates a printer for the specified format
func NewPrinter(format string, noColor bool) *Printer {
    return &Printer{
        writer:  os.Stdout,
        format:  format,
        noColor: noColor,
    }
}

// Print outputs the given objects in the configured format
func (p *Printer) Print(v interface{}) error {
    switch p.format {
    case "json":
        return p.printJSON(v)
    case "yaml":
        return p.printYAML(v)
    case "table":
        return p.printTable(v)
    case "wide":
        return p.printTableWide(v)
    default:
        return fmt.Errorf("unknown output format: %s", p.format)
    }
}

func (p *Printer) printJSON(v interface{}) error {
    encoder := json.NewEncoder(p.writer)
    encoder.SetIndent("", "  ")
    return encoder.Encode(v)
}

func (p *Printer) printYAML(v interface{}) error {
    encoder := yaml.NewEncoder(p.writer)
    encoder.SetIndent(2)
    return encoder.Encode(v)
}

// Printable must be implemented by types that support table output
type Printable interface {
    TableHeaders() []string
    TableRow() []string
    TableRowWide() []string
}

func (p *Printer) printTable(v interface{}) error {
    w := tabwriter.NewWriter(p.writer, 0, 0, 2, ' ', 0)
    defer w.Flush()

    items := toSlice(v)
    if len(items) == 0 {
        fmt.Fprintln(w, "No resources found")
        return nil
    }

    first, ok := items[0].(Printable)
    if !ok {
        return fmt.Errorf("type does not implement Printable interface")
    }

    // Print header
    headers := first.TableHeaders()
    if !p.noColor {
        fmt.Fprintln(w, colorize(strings.Join(headers, "\t"), Bold))
    } else {
        fmt.Fprintln(w, strings.Join(headers, "\t"))
    }

    // Print rows
    for _, item := range items {
        p, ok := item.(Printable)
        if !ok {
            continue
        }
        fmt.Fprintln(w, strings.Join(p.TableRow(), "\t"))
    }

    return nil
}

func toSlice(v interface{}) []interface{} {
    val := reflect.ValueOf(v)
    if val.Kind() == reflect.Ptr {
        val = val.Elem()
    }
    if val.Kind() != reflect.Slice {
        return []interface{}{v}
    }
    result := make([]interface{}, val.Len())
    for i := 0; i < val.Len(); i++ {
        result[i] = val.Index(i).Interface()
    }
    return result
}
```

## Testing CLI Commands

Testing cobra commands requires invoking them programmatically:

```go
// cmd/get/get_users_test.go
package get_test

import (
    "bytes"
    "encoding/json"
    "testing"

    "github.com/spf13/cobra"
    "github.com/spf13/viper"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"

    "myctl/internal/testutil"
    "myctl/pkg/client/mock"
)

func TestGetUsers(t *testing.T) {
    tests := []struct {
        name           string
        args           []string
        setupMock      func(*mock.APIClient)
        expectedOutput func(t *testing.T, output string)
        expectedErr    string
    }{
        {
            name: "list all users in table format",
            args: []string{"users"},
            setupMock: func(m *mock.APIClient) {
                m.On("Users().List", mock.Anything, mock.Anything).
                    Return([]*User{
                        {Name: "alice", Email: "alice@example.com", Status: "active"},
                        {Name: "bob", Email: "bob@example.com", Status: "inactive"},
                    }, nil)
            },
            expectedOutput: func(t *testing.T, output string) {
                assert.Contains(t, output, "alice")
                assert.Contains(t, output, "bob")
                assert.Contains(t, output, "NAME")
            },
        },
        {
            name: "get specific user in JSON format",
            args: []string{"users", "alice", "-o", "json"},
            setupMock: func(m *mock.APIClient) {
                m.On("Users().Get", mock.Anything, "alice").
                    Return(&User{
                        Name:  "alice",
                        Email: "alice@example.com",
                    }, nil)
            },
            expectedOutput: func(t *testing.T, output string) {
                var users []*User
                require.NoError(t, json.Unmarshal([]byte(output), &users))
                assert.Len(t, users, 1)
                assert.Equal(t, "alice", users[0].Name)
            },
        },
        {
            name: "user not found returns error",
            args: []string{"users", "nonexistent"},
            setupMock: func(m *mock.APIClient) {
                m.On("Users().Get", mock.Anything, "nonexistent").
                    Return(nil, ErrNotFound)
            },
            expectedErr: "not found",
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            // Reset viper for each test
            viper.Reset()
            viper.Set("output", "table")

            // Create mock client
            mockClient := &mock.APIClient{}
            if tt.setupMock != nil {
                tt.setupMock(mockClient)
            }

            // Create a new root command with the mock injected
            root := testutil.NewTestRootCmd(mockClient)

            // Capture output
            var stdout, stderr bytes.Buffer
            root.SetOut(&stdout)
            root.SetErr(&stderr)

            root.SetArgs(tt.args)
            err := root.Execute()

            if tt.expectedErr != "" {
                require.Error(t, err)
                assert.Contains(t, err.Error(), tt.expectedErr)
                return
            }

            require.NoError(t, err)
            if tt.expectedOutput != nil {
                tt.expectedOutput(t, stdout.String())
            }

            mockClient.AssertExpectations(t)
        })
    }
}
```

## Environment Variable Binding Reference

Viper's environment variable binding with `MYCTL_` prefix:

```bash
# These environment variables are equivalent to their flag counterparts
export MYCTL_OUTPUT=json              # --output json
export MYCTL_CONTEXT=production       # --context production
export MYCTL_VERBOSE=true             # --verbose
export MYCTL_TIMEOUT=60s              # --timeout 60s
export MYCTL_NO_COLOR=true            # --no-color

# Nested config keys use underscores
export MYCTL_GET_USERS_LIMIT=500      # --limit 500 in get users
export MYCTL_API_URL=https://api.mycompany.com

# Config path override
export MYCTL_CONFIG=/path/to/config.yaml

# Plugin path
export MYCTL_PLUGIN_PATH=/opt/myctl-plugins

# Test with overrides
MYCTL_OUTPUT=json MYCTL_CONTEXT=staging myctl get users
```

## Key Takeaways

Building production-quality CLIs with cobra and viper requires attention to several dimensions beyond just making commands work:

**Configuration hierarchy**: Viper's layered configuration (flags > env vars > config file > defaults) mirrors what users expect from enterprise tools. The `MYCTL_` prefix for environment variables prevents conflicts and provides a clear namespace.

**Shell completion is mandatory**: Modern CLIs without shell completion are frustrating to use. Cobra's built-in completion generation, combined with dynamic completion functions that query the API, makes the difference between a tool teams adopt and one they avoid.

**Plugin systems enable extensibility**: Following kubectl's pattern of searching PATH for `myctl-*` binaries allows teams to extend the CLI without requiring changes to the core binary. This is especially valuable for organization-specific commands.

**Output formatting**: Supporting table, JSON, and YAML output enables the CLI to be used both interactively (table) and in scripts (`-o json | jq`). The `Printable` interface pattern cleanly separates display logic from business logic.

**Test command execution**: Testing cobra commands by invoking `Execute()` with `SetArgs()` and capturing output with `SetOut()` enables comprehensive integration testing of CLI behavior without external process spawning.
