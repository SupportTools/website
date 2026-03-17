---
title: "Go CLI Development: cobra, viper, and Plugin Architecture"
date: 2029-08-26T00:00:00-05:00
draft: false
tags: ["Go", "CLI", "cobra", "viper", "Plugins", "DevOps Tools", "Command Line"]
categories: ["Go", "CLI Development", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Go CLI development with cobra command hierarchy, viper configuration binding with environment variable precedence, shell completions, and plugin discovery via PATH for extensible developer tools."
more_link: "yes"
url: "/go-cli-development-cobra-viper-plugin-architecture/"
---

Production-grade CLI tools share common patterns: hierarchical subcommands, configuration layering (flags > environment > config file > defaults), shell autocompletion for usability, and plugin systems for extensibility. kubectl, helm, and the GitHub CLI all follow these patterns. This post builds a complete CLI tool using cobra and viper, covering configuration precedence, shell completions, and a kubectl-style plugin discovery system.

<!--more-->

# Go CLI Development: cobra, viper, and Plugin Architecture

## Project Structure

A well-structured CLI follows this layout:

```
mycli/
├── cmd/
│   ├── root.go           # Root command, global flags, PersistentPreRun
│   ├── version.go        # mycli version
│   ├── completion.go     # mycli completion bash|zsh|fish|powershell
│   ├── config.go         # mycli config get/set/view
│   ├── get.go            # mycli get <resource>
│   └── create.go         # mycli create <resource>
├── pkg/
│   ├── config/           # Configuration management
│   ├── client/           # API client
│   └── output/           # Output formatters (table, json, yaml)
├── internal/
│   └── plugin/           # Plugin discovery and execution
├── main.go
└── go.mod
```

## Setting Up cobra

```go
// main.go
package main

import (
    "os"

    "mycli/cmd"
)

func main() {
    if err := cmd.Execute(); err != nil {
        os.Exit(1)
    }
}
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
    "mycli/pkg/config"
    "mycli/internal/plugin"
)

var (
    cfgFile    string
    outputFmt  string
    noColor    bool
    verbose    bool
)

// rootCmd represents the base command
var rootCmd = &cobra.Command{
    Use:   "mycli",
    Short: "A production-grade CLI tool",
    Long: `mycli is a CLI for managing infrastructure resources.

Complete documentation is available at https://docs.mycompany.com/mycli`,

    // SilenceUsage prevents printing usage on every error
    // Only show usage for actual usage errors, not runtime errors
    SilenceUsage: true,

    // SilenceErrors lets us control error formatting
    SilenceErrors: true,

    // PersistentPreRunE runs before every subcommand
    // Use for authentication, context setup, etc.
    PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
        // Skip for commands that don't need auth
        annotations := cmd.Annotations
        if annotations != nil {
            if _, ok := annotations["skipAuth"]; ok {
                return nil
            }
        }

        return config.ValidateContext()
    },
}

// Execute adds all child commands to the root command and sets flags.
// This is called by main.main(). It only needs to happen once.
func Execute() error {
    // Plugin discovery: find mycli-* executables in PATH
    pluginFinder := plugin.NewFinder("mycli")
    if err := pluginFinder.AddToRoot(rootCmd); err != nil {
        // Plugin errors are non-fatal — log and continue
        fmt.Fprintf(os.Stderr, "Warning: plugin discovery error: %v\n", err)
    }

    err := rootCmd.Execute()
    if err != nil {
        fmt.Fprintf(os.Stderr, "Error: %v\n", err)
    }
    return err
}

func init() {
    cobra.OnInitialize(initConfig)

    // Global persistent flags (available to all subcommands)
    rootCmd.PersistentFlags().StringVar(&cfgFile, "config", "",
        "config file (default: $HOME/.mycli/config.yaml)")

    rootCmd.PersistentFlags().StringVarP(&outputFmt, "output", "o", "table",
        "Output format: table|json|yaml|wide")
    viper.BindPFlag("output", rootCmd.PersistentFlags().Lookup("output"))

    rootCmd.PersistentFlags().BoolVar(&noColor, "no-color", false,
        "Disable color output")
    viper.BindPFlag("no_color", rootCmd.PersistentFlags().Lookup("no-color"))

    rootCmd.PersistentFlags().BoolVarP(&verbose, "verbose", "v", false,
        "Enable verbose logging")
    viper.BindPFlag("verbose", rootCmd.PersistentFlags().Lookup("verbose"))

    // Context flag — which cluster/environment to use
    rootCmd.PersistentFlags().String("context", "",
        "Override current context")
    viper.BindPFlag("context", rootCmd.PersistentFlags().Lookup("context"))

    // Add subcommands
    rootCmd.AddCommand(versionCmd)
    rootCmd.AddCommand(completionCmd)
    rootCmd.AddCommand(configCmd)
    rootCmd.AddCommand(getCmd)
    rootCmd.AddCommand(createCmd)
}

func initConfig() {
    if cfgFile != "" {
        // Use config file from flag
        viper.SetConfigFile(cfgFile)
    } else {
        // Find home directory
        home, err := os.UserHomeDir()
        cobra.CheckErr(err)

        // Search config in ~/.mycli/
        viper.AddConfigPath(filepath.Join(home, ".mycli"))
        viper.AddConfigPath(".")
        viper.SetConfigType("yaml")
        viper.SetConfigName("config")
    }

    // Read environment variables
    // All MYCLI_* env vars are automatically bound
    viper.SetEnvPrefix("MYCLI")
    viper.AutomaticEnv()
    // Map dashes to underscores in env var names
    // MYCLI_API_URL -> api-url
    viper.SetEnvKeyReplacer(strings.NewReplacer("-", "_"))

    // Read the config file (errors are non-fatal)
    if err := viper.ReadInConfig(); err != nil {
        if _, ok := err.(viper.ConfigFileNotFoundError); !ok {
            // Config file found but failed to parse
            fmt.Fprintf(os.Stderr, "Error reading config: %v\n", err)
        }
    }
}
```

## Viper Configuration Binding and Precedence

Viper applies configuration values in this priority order (highest to lowest):

1. explicit `Set()` calls
2. flags (pflag)
3. environment variables
4. config file
5. key/value store (etcd, Consul)
6. default values

```go
// pkg/config/config.go
package config

import (
    "fmt"
    "os"
    "path/filepath"
    "time"

    "github.com/spf13/viper"
    "gopkg.in/yaml.v3"
)

// Config holds all configuration for mycli
type Config struct {
    // Server settings
    APIEndpoint   string        `mapstructure:"api_endpoint" yaml:"api_endpoint"`
    APITimeout    time.Duration `mapstructure:"api_timeout"  yaml:"api_timeout"`
    TLSSkipVerify bool          `mapstructure:"tls_skip_verify" yaml:"tls_skip_verify"`

    // Authentication
    Token         string `mapstructure:"token"    yaml:"token,omitempty"`
    CertFile      string `mapstructure:"cert_file" yaml:"cert_file,omitempty"`
    KeyFile       string `mapstructure:"key_file"  yaml:"key_file,omitempty"`

    // Behavior
    CurrentContext string        `mapstructure:"current_context" yaml:"current_context"`
    OutputFormat   string        `mapstructure:"output"          yaml:"output"`
    NoColor        bool          `mapstructure:"no_color"        yaml:"no_color"`
    Verbose        bool          `mapstructure:"verbose"         yaml:"verbose"`
    CacheTimeout   time.Duration `mapstructure:"cache_timeout"   yaml:"cache_timeout"`

    // Contexts (named configurations)
    Contexts map[string]ContextConfig `mapstructure:"contexts" yaml:"contexts"`
}

type ContextConfig struct {
    APIEndpoint string `mapstructure:"api_endpoint" yaml:"api_endpoint"`
    Token       string `mapstructure:"token"        yaml:"token,omitempty"`
    Namespace   string `mapstructure:"namespace"    yaml:"namespace"`
}

// SetDefaults configures default values in viper
func SetDefaults() {
    viper.SetDefault("api_endpoint", "https://api.mycompany.com")
    viper.SetDefault("api_timeout", "30s")
    viper.SetDefault("tls_skip_verify", false)
    viper.SetDefault("output", "table")
    viper.SetDefault("no_color", false)
    viper.SetDefault("verbose", false)
    viper.SetDefault("cache_timeout", "5m")
    viper.SetDefault("current_context", "default")
}

// Get returns the current configuration
func Get() (*Config, error) {
    cfg := &Config{}
    if err := viper.Unmarshal(cfg); err != nil {
        return nil, fmt.Errorf("unmarshaling config: %w", err)
    }

    // Apply context-specific overrides
    if ctx, ok := cfg.Contexts[cfg.CurrentContext]; ok {
        if ctx.APIEndpoint != "" {
            cfg.APIEndpoint = ctx.APIEndpoint
        }
        if ctx.Token != "" {
            cfg.Token = ctx.Token
        }
    }

    return cfg, nil
}

// ValidateContext checks that the current context is usable
func ValidateContext() error {
    cfg, err := Get()
    if err != nil {
        return err
    }

    if cfg.APIEndpoint == "" {
        return fmt.Errorf("no API endpoint configured. Set MYCLI_API_ENDPOINT or run 'mycli config set api_endpoint <url>'")
    }

    if cfg.Token == "" && cfg.CertFile == "" {
        return fmt.Errorf("no authentication configured. Set MYCLI_TOKEN or run 'mycli config set token <token>'")
    }

    return nil
}

// ConfigFilePath returns the path to the config file
func ConfigFilePath() string {
    home, _ := os.UserHomeDir()
    return filepath.Join(home, ".mycli", "config.yaml")
}

// SaveConfig writes the current configuration to disk
func SaveConfig(cfg *Config) error {
    path := ConfigFilePath()
    if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
        return err
    }

    f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
    if err != nil {
        return err
    }
    defer f.Close()

    return yaml.NewEncoder(f).Encode(cfg)
}
```

### Config Subcommand

```go
// cmd/config.go
package cmd

import (
    "fmt"
    "os"

    "github.com/spf13/cobra"
    "github.com/spf13/viper"
    "gopkg.in/yaml.v3"

    "mycli/pkg/config"
)

var configCmd = &cobra.Command{
    Use:   "config",
    Short: "Manage mycli configuration",
    Long:  "View and modify mycli configuration settings",
}

var configViewCmd = &cobra.Command{
    Use:     "view",
    Short:   "View current configuration",
    Example: "  mycli config view",
    Annotations: map[string]string{
        "skipAuth": "true",
    },
    RunE: func(cmd *cobra.Command, args []string) error {
        cfg, err := config.Get()
        if err != nil {
            return err
        }

        // Redact sensitive values
        if cfg.Token != "" {
            cfg.Token = cfg.Token[:8] + "..."
        }

        return yaml.NewEncoder(os.Stdout).Encode(cfg)
    },
}

var configGetCmd = &cobra.Command{
    Use:     "get <key>",
    Short:   "Get a configuration value",
    Example: "  mycli config get api_endpoint",
    Args:    cobra.ExactArgs(1),
    Annotations: map[string]string{
        "skipAuth": "true",
    },
    RunE: func(cmd *cobra.Command, args []string) error {
        key := args[0]
        value := viper.Get(key)
        if value == nil {
            return fmt.Errorf("unknown config key: %s", key)
        }
        fmt.Println(value)
        return nil
    },
}

var configSetCmd = &cobra.Command{
    Use:     "set <key> <value>",
    Short:   "Set a configuration value",
    Example: "  mycli config set api_endpoint https://api.mycompany.com",
    Args:    cobra.ExactArgs(2),
    Annotations: map[string]string{
        "skipAuth": "true",
    },
    RunE: func(cmd *cobra.Command, args []string) error {
        key := args[0]
        value := args[1]

        cfg, err := config.Get()
        if err != nil {
            // Config may not exist yet
            cfg = &config.Config{}
        }

        // Update via viper (handles type conversion)
        viper.Set(key, value)

        // Re-read and save
        if err := viper.Unmarshal(cfg); err != nil {
            return err
        }

        if err := config.SaveConfig(cfg); err != nil {
            return fmt.Errorf("saving config: %w", err)
        }

        fmt.Printf("Set %s = %s\n", key, value)
        return nil
    },
}

var configUseContextCmd = &cobra.Command{
    Use:     "use-context <context-name>",
    Short:   "Switch to a different context",
    Example: "  mycli config use-context production",
    Args:    cobra.ExactArgs(1),
    Annotations: map[string]string{
        "skipAuth": "true",
    },
    RunE: func(cmd *cobra.Command, args []string) error {
        contextName := args[0]

        cfg, err := config.Get()
        if err != nil {
            return err
        }

        if _, ok := cfg.Contexts[contextName]; !ok {
            return fmt.Errorf("context %q not found. Available: %v",
                contextName, contextNames(cfg.Contexts))
        }

        cfg.CurrentContext = contextName
        if err := config.SaveConfig(cfg); err != nil {
            return err
        }

        fmt.Printf("Switched to context %q\n", contextName)
        return nil
    },
    ValidArgsFunction: func(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
        cfg, err := config.Get()
        if err != nil {
            return nil, cobra.ShellCompDirectiveError
        }
        return contextNames(cfg.Contexts), cobra.ShellCompDirectiveNoFileComp
    },
}

func init() {
    configCmd.AddCommand(configViewCmd)
    configCmd.AddCommand(configGetCmd)
    configCmd.AddCommand(configSetCmd)
    configCmd.AddCommand(configUseContextCmd)
}

func contextNames(ctxs map[string]config.ContextConfig) []string {
    names := make([]string, 0, len(ctxs))
    for name := range ctxs {
        names = append(names, name)
    }
    return names
}
```

## Shell Completions

```go
// cmd/completion.go
package cmd

import (
    "fmt"
    "os"

    "github.com/spf13/cobra"
)

var completionCmd = &cobra.Command{
    Use:   "completion [bash|zsh|fish|powershell]",
    Short: "Generate shell completion scripts",
    Long: `Generate shell completion scripts for mycli.

To load completions:

Bash:
  $ source <(mycli completion bash)
  # To load completions for each session, add to ~/.bashrc:
  $ echo 'source <(mycli completion bash)' >> ~/.bashrc

Zsh:
  # If shell completion is not already enabled in your environment,
  # you will need to enable it. You can execute the following once:
  $ echo "autoload -U compinit; compinit" >> ~/.zshrc
  # To load completions for each session:
  $ mycli completion zsh > "${fpath[1]}/_mycli"
  # You will need to start a new shell for this setup to take effect.

Fish:
  $ mycli completion fish | source
  # To load completions for each session:
  $ mycli completion fish > ~/.config/fish/completions/mycli.fish

PowerShell:
  PS> mycli completion powershell | Out-String | Invoke-Expression
`,
    DisableFlagsInUseLine: true,
    ValidArgs:             []string{"bash", "zsh", "fish", "powershell"},
    Args:                  cobra.ExactValidArgs(1),
    Annotations: map[string]string{
        "skipAuth": "true",
    },
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
        default:
            return fmt.Errorf("unsupported shell: %s", args[0])
        }
    },
}
```

### Dynamic Completions

```go
// cmd/get.go
package cmd

import (
    "fmt"

    "github.com/spf13/cobra"
    "mycli/pkg/client"
)

var getCmd = &cobra.Command{
    Use:   "get <resource> [name]",
    Short: "Get resources",
    Example: `  # List all deployments
  mycli get deployments

  # Get a specific deployment
  mycli get deployment myapp

  # Get with specific output format
  mycli get deployment myapp -o json`,
    ValidArgs: []string{"deployment", "service", "pod", "namespace", "node"},
    Args:      cobra.RangeArgs(1, 2),
    RunE: func(cmd *cobra.Command, args []string) error {
        resourceType := args[0]
        resourceName := ""
        if len(args) == 2 {
            resourceName = args[1]
        }

        // ... implementation
        fmt.Printf("Getting %s %s\n", resourceType, resourceName)
        return nil
    },
}

func init() {
    // Register dynamic completion for resource names
    // When user types: mycli get deployment <TAB>
    // This function is called to provide completions
    getCmd.RegisterFlagCompletionFunc("namespace",
        func(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
            // Fetch namespaces from API
            namespaces, err := client.ListNamespaces(cmd.Context())
            if err != nil {
                return nil, cobra.ShellCompDirectiveError
            }
            return namespaces, cobra.ShellCompDirectiveNoFileComp
        })

    // Dynamic completion for positional args
    // When user types: mycli get deployment <TAB>
    // args[0] = "deployment" when completing args[1]
    getCmd.ValidArgsFunction = func(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
        if len(args) == 0 {
            // Completing resource type
            return []string{
                "deployment\tManage application deployments",
                "service\tNetwork services",
                "pod\tRunning workload instances",
                "namespace\tIsolation boundaries",
                "node\tCluster nodes",
            }, cobra.ShellCompDirectiveNoFileComp
        }

        if len(args) == 1 {
            // Completing resource name based on resource type
            resourceType := args[0]
            names, err := client.ListResourceNames(cmd.Context(), resourceType)
            if err != nil {
                return nil, cobra.ShellCompDirectiveError
            }
            return names, cobra.ShellCompDirectiveNoFileComp
        }

        return nil, cobra.ShellCompDirectiveNoFileComp
    }

    getCmd.PersistentFlags().StringP("namespace", "n", "",
        "Namespace to query (default: current context namespace)")
    getCmd.PersistentFlags().StringP("label-selector", "l", "",
        "Filter by label selector")
}
```

## Plugin Architecture

kubectl's plugin system is the gold standard: any executable named `kubectl-*` in PATH becomes a subcommand. We implement the same pattern.

### Plugin Discovery

```go
// internal/plugin/finder.go
package plugin

import (
    "fmt"
    "os"
    "os/exec"
    "path/filepath"
    "strings"

    "github.com/spf13/cobra"
)

// Finder discovers and loads CLI plugins from PATH
type Finder struct {
    prefix string // e.g., "mycli"
}

func NewFinder(prefix string) *Finder {
    return &Finder{prefix: prefix}
}

// Find returns all plugin executables found in PATH
func (f *Finder) Find() ([]PluginInfo, error) {
    var plugins []PluginInfo
    seen := make(map[string]bool)

    path := os.Getenv("PATH")
    dirs := filepath.SplitList(path)

    for _, dir := range dirs {
        entries, err := os.ReadDir(dir)
        if err != nil {
            continue // Skip unreadable directories
        }

        for _, entry := range entries {
            if entry.IsDir() {
                continue
            }

            name := entry.Name()
            if !strings.HasPrefix(name, f.prefix+"-") {
                continue
            }

            fullPath := filepath.Join(dir, name)

            // Skip if not executable
            info, err := entry.Info()
            if err != nil {
                continue
            }
            if info.Mode()&0111 == 0 {
                continue
            }

            // Skip duplicates (first PATH entry wins)
            if seen[name] {
                continue
            }
            seen[name] = true

            // Convert filename to subcommand name
            // mycli-get-deployments -> get deployments
            pluginName := strings.TrimPrefix(name, f.prefix+"-")
            // Replace dashes with spaces for multi-word subcommands
            // mycli-get-all -> "get all" -> [get, all]
            parts := strings.Split(pluginName, "-")

            plugins = append(plugins, PluginInfo{
                Name:     pluginName,
                Parts:    parts,
                FullPath: fullPath,
            })
        }
    }

    return plugins, nil
}

// AddToRoot adds discovered plugins to the cobra root command
func (f *Finder) AddToRoot(root *cobra.Command) error {
    plugins, err := f.Find()
    if err != nil {
        return err
    }

    for _, plugin := range plugins {
        p := plugin // capture loop variable
        cmd := f.buildCommand(root, p)
        if cmd != nil {
            f.addCommandAtPath(root, p.Parts, cmd)
        }
    }

    return nil
}

// buildCommand creates a cobra.Command that executes the plugin
func (f *Finder) buildCommand(root *cobra.Command, p PluginInfo) *cobra.Command {
    // Don't override existing commands
    if cmd, _, err := root.Find(p.Parts); err == nil && cmd.Use != "" {
        // Command exists — skip this plugin
        return nil
    }

    return &cobra.Command{
        Use:                p.Parts[len(p.Parts)-1],
        Short:              fmt.Sprintf("Plugin: %s", p.FullPath),
        DisableFlagParsing: true,
        Annotations: map[string]string{
            "skipAuth":   "true",
            "pluginPath": p.FullPath,
        },
        RunE: func(cmd *cobra.Command, args []string) error {
            return f.runPlugin(p.FullPath, args, cmd)
        },
    }
}

// runPlugin executes the plugin binary with os/exec
func (f *Finder) runPlugin(pluginPath string, args []string, cmd *cobra.Command) error {
    execCmd := exec.Command(pluginPath, args...)
    execCmd.Stdin = os.Stdin
    execCmd.Stdout = os.Stdout
    execCmd.Stderr = os.Stderr

    // Forward environment variables
    execCmd.Env = os.Environ()

    // Add mycli-specific environment for plugins to use
    execCmd.Env = append(execCmd.Env,
        fmt.Sprintf("MYCLI_COMMAND_PATH=%s", strings.Join(commandPath(cmd), " ")),
    )

    return execCmd.Run()
}

// addCommandAtPath adds a command at the given path in the command tree
// e.g., parts = ["get", "all"] adds cmd as root -> get -> all
func (f *Finder) addCommandAtPath(root *cobra.Command, parts []string, cmd *cobra.Command) {
    if len(parts) == 1 {
        root.AddCommand(cmd)
        return
    }

    // Find or create parent command
    parentParts := parts[:len(parts)-1]
    parent, _, err := root.Find(parentParts)
    if err != nil || parent.Use == "" || parent == root {
        // Parent command doesn't exist — create a placeholder group command
        groupCmd := &cobra.Command{
            Use:   parentParts[len(parentParts)-1],
            Short: fmt.Sprintf("%s commands", parentParts[len(parentParts)-1]),
        }
        f.addCommandAtPath(root, parentParts, groupCmd)
        parent, _, _ = root.Find(parentParts)
    }

    parent.AddCommand(cmd)
}

func commandPath(cmd *cobra.Command) []string {
    var parts []string
    for c := cmd; c != nil; c = c.Parent() {
        parts = append([]string{c.Use}, parts...)
    }
    return parts
}

// PluginInfo holds metadata about a discovered plugin
type PluginInfo struct {
    Name     string
    Parts    []string
    FullPath string
}
```

### Writing a Plugin

Plugins are standalone executables. Here's a complete example plugin:

```go
// cmd/mycli-deploy/main.go — Plugin for deployment operations
package main

import (
    "fmt"
    "os"

    "github.com/spf13/cobra"
    "github.com/spf13/viper"
)

func main() {
    // Plugins receive the full argument list
    // args[0] might be the parent command path from MYCLI_COMMAND_PATH
    rootCmd := &cobra.Command{
        Use:   "mycli-deploy",
        Short: "Deploy resources to clusters",
    }

    rootCmd.AddCommand(deployRunCmd)
    rootCmd.AddCommand(deployStatusCmd)
    rootCmd.AddCommand(deployRollbackCmd)

    if err := rootCmd.Execute(); err != nil {
        fmt.Fprintln(os.Stderr, err)
        os.Exit(1)
    }
}

var deployRunCmd = &cobra.Command{
    Use:   "run <app> <version>",
    Short: "Deploy an application version",
    Args:  cobra.ExactArgs(2),
    RunE: func(cmd *cobra.Command, args []string) error {
        app := args[0]
        version := args[1]

        // Read mycli's configuration from environment
        apiEndpoint := os.Getenv("MYCLI_API_ENDPOINT")
        token := os.Getenv("MYCLI_TOKEN")

        fmt.Printf("Deploying %s version %s to %s\n", app, version, apiEndpoint)
        // ... deployment logic

        _ = token
        return nil
    },
}

var deployStatusCmd = &cobra.Command{
    Use:   "status <app>",
    Short: "Check deployment status",
    Args:  cobra.ExactArgs(1),
    RunE: func(cmd *cobra.Command, args []string) error {
        fmt.Printf("Status for %s: OK\n", args[0])
        return nil
    },
}

var deployRollbackCmd = &cobra.Command{
    Use:   "rollback <app>",
    Short: "Roll back to previous version",
    Args:  cobra.ExactArgs(1),
    RunE: func(cmd *cobra.Command, args []string) error {
        fmt.Printf("Rolling back %s...\n", args[0])
        return nil
    },
}
```

```bash
# Install the plugin to make it available as a mycli subcommand
go build -o /usr/local/bin/mycli-deploy ./cmd/mycli-deploy/

# Now available as:
mycli deploy run myapp 1.2.3
mycli deploy status myapp
mycli deploy rollback myapp

# List available plugins
mycli plugin list  # (if you implement this command)
```

### Plugin List Command

```go
// cmd/plugin.go
package cmd

import (
    "fmt"
    "os"
    "text/tabwriter"

    "github.com/spf13/cobra"
    "mycli/internal/plugin"
)

var pluginCmd = &cobra.Command{
    Use:   "plugin",
    Short: "Manage mycli plugins",
}

var pluginListCmd = &cobra.Command{
    Use:   "list",
    Short: "List installed plugins",
    Annotations: map[string]string{
        "skipAuth": "true",
    },
    RunE: func(cmd *cobra.Command, args []string) error {
        finder := plugin.NewFinder("mycli")
        plugins, err := finder.Find()
        if err != nil {
            return err
        }

        if len(plugins) == 0 {
            fmt.Println("No plugins found in PATH")
            return nil
        }

        w := tabwriter.NewWriter(os.Stdout, 0, 0, 3, ' ', 0)
        fmt.Fprintln(w, "NAME\tPATH\tSUBCOMMAND")
        for _, p := range plugins {
            fmt.Fprintf(w, "%s\t%s\t%s\n",
                p.Name,
                p.FullPath,
                "mycli "+strings.Join(p.Parts, " "),
            )
        }
        w.Flush()
        return nil
    },
}

func init() {
    pluginCmd.AddCommand(pluginListCmd)
    rootCmd.AddCommand(pluginCmd)
}
```

## Output Formatting

Production CLIs need consistent output formatting with support for machine-readable output:

```go
// pkg/output/printer.go
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

type Printer struct {
    format string
    writer io.Writer
    noColor bool
}

func New(format string, noColor bool) *Printer {
    return &Printer{
        format:  format,
        writer:  os.Stdout,
        noColor: noColor,
    }
}

// Print outputs the given object in the configured format
func (p *Printer) Print(obj interface{}) error {
    switch p.format {
    case "json":
        return p.printJSON(obj)
    case "yaml":
        return p.printYAML(obj)
    case "table", "wide", "":
        return p.printTable(obj)
    default:
        return fmt.Errorf("unknown output format: %s", p.format)
    }
}

func (p *Printer) printJSON(obj interface{}) error {
    enc := json.NewEncoder(p.writer)
    enc.SetIndent("", "  ")
    return enc.Encode(obj)
}

func (p *Printer) printYAML(obj interface{}) error {
    return yaml.NewEncoder(p.writer).Encode(obj)
}

func (p *Printer) printTable(obj interface{}) error {
    w := tabwriter.NewWriter(p.writer, 0, 0, 3, ' ', 0)
    defer w.Flush()

    // Use reflection to handle slices of structs
    v := reflect.ValueOf(obj)
    if v.Kind() == reflect.Ptr {
        v = v.Elem()
    }

    if v.Kind() == reflect.Slice {
        if v.Len() == 0 {
            fmt.Fprintln(p.writer, "No resources found")
            return nil
        }

        // Print header row from struct tags
        elem := v.Type().Elem()
        if elem.Kind() == reflect.Ptr {
            elem = elem.Elem()
        }

        var headers []string
        for i := 0; i < elem.NumField(); i++ {
            field := elem.Field(i)
            tag := field.Tag.Get("table")
            if tag == "-" {
                continue
            }
            if tag == "" {
                tag = field.Name
            }
            headers = append(headers, tag)
        }
        fmt.Fprintln(w, strings.Join(headers, "\t"))

        // Print rows
        for i := 0; i < v.Len(); i++ {
            row := v.Index(i)
            if row.Kind() == reflect.Ptr {
                row = row.Elem()
            }

            var values []string
            for j := 0; j < row.NumField(); j++ {
                field := elem.Field(j)
                if field.Tag.Get("table") == "-" {
                    continue
                }
                values = append(values, fmt.Sprintf("%v", row.Field(j).Interface()))
            }
            fmt.Fprintln(w, strings.Join(values, "\t"))
        }
    }

    return nil
}
```

## Testing CLI Commands

```go
// cmd/get_test.go
package cmd_test

import (
    "bytes"
    "testing"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

func TestGetCommand(t *testing.T) {
    tests := []struct {
        name       string
        args       []string
        wantErr    bool
        wantOutput string
    }{
        {
            name:    "get with no resource type returns error",
            args:    []string{"get"},
            wantErr: true,
        },
        {
            name:       "get deployments returns table",
            args:       []string{"get", "deployments"},
            wantOutput: "NAME",
        },
        {
            name:       "get deployments json output",
            args:       []string{"get", "deployments", "-o", "json"},
            wantOutput: `"name"`,
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            // Capture output
            buf := new(bytes.Buffer)
            rootCmd.SetOut(buf)
            rootCmd.SetErr(buf)

            rootCmd.SetArgs(tt.args)

            err := rootCmd.Execute()

            if tt.wantErr {
                require.Error(t, err)
                return
            }

            require.NoError(t, err)
            if tt.wantOutput != "" {
                assert.Contains(t, buf.String(), tt.wantOutput)
            }
        })
    }
}
```

## Makefile for CLI Distribution

```makefile
# Makefile
BINARY     = mycli
VERSION    ?= $(shell git describe --tags --always --dirty)
BUILD_TIME  = $(shell date -u +"%Y-%m-%dT%H:%M:%SZ")
LDFLAGS    = -ldflags "-X main.version=$(VERSION) -X main.buildTime=$(BUILD_TIME)"

.PHONY: build
build:
	go build $(LDFLAGS) -o bin/$(BINARY) ./main.go

.PHONY: install
install: build
	install -m 0755 bin/$(BINARY) /usr/local/bin/$(BINARY)

.PHONY: completions
completions: build
	bin/$(BINARY) completion bash > completions/$(BINARY).bash
	bin/$(BINARY) completion zsh  > completions/_$(BINARY)
	bin/$(BINARY) completion fish > completions/$(BINARY).fish

.PHONY: release
release:
	goreleaser release --rm-dist

.PHONY: test
test:
	go test ./... -race -timeout 60s

.PHONY: lint
lint:
	golangci-lint run ./...
```

The combination of cobra, viper, and a PATH-based plugin system provides the foundation for a production-grade CLI tool that is extensible, configurable, and user-friendly. The configuration precedence model ensures operators can configure the tool through flags, environment variables, or config files without ambiguity, while the plugin system enables the tool to grow without requiring changes to the core binary.
