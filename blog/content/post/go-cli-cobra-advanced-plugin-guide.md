---
title: "Go CLI Development: Cobra Advanced Patterns, Shell Completion, Plugin Architecture, and Distribution"
date: 2028-09-02T00:00:00-05:00
draft: false
tags: ["Go", "CLI", "Cobra", "Shell Completion", "Plugin", "Distribution"]
categories:
- Go
author: "Matthew Mattox - mmattox@support.tools"
description: "Master advanced Cobra CLI development in Go: command hierarchies, persistent flags, shell autocompletion, plugin systems via exec delegation, goreleaser distribution, and testable CLI design."
more_link: "yes"
url: "/go-cli-cobra-advanced-plugin-guide/"
---

The Go ecosystem has produced some of the most widely used CLI tools in infrastructure: kubectl, helm, terraform, and hugo. Cobra is the backbone of nearly all of them. This guide goes beyond the basics — covering hierarchical command design, persistent pre/post hooks, dynamic shell completions, plugin discovery and delegation, cross-platform binary distribution with GoReleaser, and a testing strategy that achieves full command coverage without shelling out.

<!--more-->

# Go CLI Development: Cobra Advanced Patterns, Shell Completion, Plugin Architecture, and Distribution

## Section 1: Project Structure and Module Setup

A production CLI deserves a deliberate layout:

```
mycli/
├── cmd/
│   ├── root.go          # Root command, global flags, logger init
│   ├── version.go       # version subcommand
│   ├── config/
│   │   ├── config.go    # config root
│   │   ├── get.go       # config get
│   │   └── set.go       # config set
│   ├── resource/
│   │   ├── resource.go  # resource root
│   │   ├── list.go
│   │   ├── get.go
│   │   ├── create.go
│   │   └── delete.go
│   └── completion.go    # completion subcommand
├── internal/
│   ├── config/          # config loading/writing
│   ├── client/          # API client
│   ├── output/          # table, JSON, YAML formatters
│   └── plugin/          # plugin discovery and exec
├── pkg/
│   └── api/             # public API types
├── main.go
├── .goreleaser.yaml
└── go.mod
```

```bash
go mod init github.com/myorg/mycli
go get github.com/spf13/cobra@latest
go get github.com/spf13/viper@latest
go get github.com/spf13/pflag@latest
go get github.com/olekukonko/tablewriter@latest
go get gopkg.in/yaml.v3
```

## Section 2: Root Command and Global Configuration

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
)

var (
    cfgFile   string
    logLevel  string
    outputFmt string
    logger    *zap.Logger
)

var rootCmd = &cobra.Command{
    Use:   "mycli",
    Short: "mycli — a production-grade infrastructure CLI",
    Long: `mycli interacts with the MyOrg platform API.

Configuration is loaded from ~/.mycli/config.yaml or the path
specified with --config. Environment variables prefixed with MYCLI_
override config file values.`,
    SilenceUsage:  true,
    SilenceErrors: true,
    PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
        return initLogger()
    },
}

func Execute() {
    if err := rootCmd.Execute(); err != nil {
        fmt.Fprintf(os.Stderr, "Error: %v\n", err)
        os.Exit(1)
    }
}

func init() {
    cobra.OnInitialize(initConfig)

    rootCmd.PersistentFlags().StringVar(&cfgFile, "config", "",
        "config file (default: $HOME/.mycli/config.yaml)")
    rootCmd.PersistentFlags().StringVarP(&logLevel, "log-level", "l", "info",
        "log level (debug, info, warn, error)")
    rootCmd.PersistentFlags().StringVarP(&outputFmt, "output", "o", "table",
        "output format: table, json, yaml")
    rootCmd.PersistentFlags().String("server", "",
        "API server URL (overrides config)")
    rootCmd.PersistentFlags().String("token", "",
        "API token (overrides config)")

    _ = viper.BindPFlag("server", rootCmd.PersistentFlags().Lookup("server"))
    _ = viper.BindPFlag("token", rootCmd.PersistentFlags().Lookup("token"))
    _ = viper.BindPFlag("output", rootCmd.PersistentFlags().Lookup("output"))
}

func initConfig() {
    if cfgFile != "" {
        viper.SetConfigFile(cfgFile)
    } else {
        home, err := os.UserHomeDir()
        cobra.CheckErr(err)
        viper.AddConfigPath(filepath.Join(home, ".mycli"))
        viper.AddConfigPath(".")
        viper.SetConfigName("config")
        viper.SetConfigType("yaml")
    }

    viper.SetEnvPrefix("MYCLI")
    viper.AutomaticEnv()

    viper.SetDefault("server", "https://api.myorg.com")
    viper.SetDefault("output", "table")

    if err := viper.ReadInConfig(); err != nil {
        if _, ok := err.(viper.ConfigFileNotFoundError); !ok {
            fmt.Fprintf(os.Stderr, "Error reading config: %v\n", err)
        }
    }
}

func initLogger() error {
    var level zapcore.Level
    if err := level.Set(logLevel); err != nil {
        return fmt.Errorf("invalid log level %q: %w", logLevel, err)
    }

    cfg := zap.NewProductionConfig()
    cfg.Level = zap.NewAtomicLevelAt(level)
    cfg.EncoderConfig.EncodeTime = zapcore.ISO8601TimeEncoder
    cfg.OutputPaths = []string{"stderr"}

    var err error
    logger, err = cfg.Build()
    return err
}
```

## Section 3: Subcommand with Validation, Completion, and Hooks

```go
// cmd/resource/list.go
package resource

import (
    "fmt"

    "github.com/myorg/mycli/internal/client"
    "github.com/myorg/mycli/internal/output"
    "github.com/spf13/cobra"
    "github.com/spf13/viper"
)

type listOptions struct {
    namespace string
    selector  string
    allNs     bool
    pageSize  int
    watch     bool
}

var listOpts listOptions

var listCmd = &cobra.Command{
    Use:     "list",
    Short:   "List resources",
    Aliases: []string{"ls", "get"},
    Example: `  # List all resources in the default namespace
  mycli resource list

  # List with label selector
  mycli resource list -n production -l app=api-server

  # All namespaces, JSON output
  mycli resource list --all-namespaces -o json`,

    ValidArgsFunction: func(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
        if len(args) > 0 {
            return nil, cobra.ShellCompDirectiveNoFileComp
        }
        c := client.NewFromViper()
        types, err := c.ListResourceTypes()
        if err != nil {
            return nil, cobra.ShellCompDirectiveError
        }
        return types, cobra.ShellCompDirectiveNoFileComp
    },

    PreRunE: func(cmd *cobra.Command, args []string) error {
        if listOpts.pageSize < 1 || listOpts.pageSize > 1000 {
            return fmt.Errorf("--page-size must be between 1 and 1000, got %d", listOpts.pageSize)
        }
        if listOpts.allNs && listOpts.namespace != "" {
            return fmt.Errorf("--all-namespaces and --namespace are mutually exclusive")
        }
        return nil
    },

    RunE: func(cmd *cobra.Command, args []string) error {
        c := client.NewFromViper()

        ns := listOpts.namespace
        if listOpts.allNs {
            ns = ""
        }
        if ns == "" && !listOpts.allNs {
            ns = viper.GetString("default_namespace")
            if ns == "" {
                ns = "default"
            }
        }

        resources, err := c.ListResources(ns, listOpts.selector, listOpts.pageSize)
        if err != nil {
            return fmt.Errorf("listing resources: %w", err)
        }

        printer, err := output.NewPrinter(viper.GetString("output"))
        if err != nil {
            return err
        }
        return printer.PrintResources(cmd.OutOrStdout(), resources)
    },
}

func init() {
    listCmd.Flags().StringVarP(&listOpts.namespace, "namespace", "n", "",
        "namespace to list resources in")
    listCmd.Flags().StringVarP(&listOpts.selector, "selector", "l", "",
        "label selector (e.g. app=myapp,env=prod)")
    listCmd.Flags().BoolVar(&listOpts.allNs, "all-namespaces", false,
        "list across all namespaces")
    listCmd.Flags().IntVar(&listOpts.pageSize, "page-size", 100,
        "number of results per page")
    listCmd.Flags().BoolVarP(&listOpts.watch, "watch", "w", false,
        "watch for changes")

    _ = listCmd.RegisterFlagCompletionFunc("namespace",
        func(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
            c := client.NewFromViper()
            namespaces, err := c.ListNamespaces()
            if err != nil {
                return nil, cobra.ShellCompDirectiveError
            }
            return namespaces, cobra.ShellCompDirectiveNoFileComp
        })

    _ = listCmd.RegisterFlagCompletionFunc("output",
        func(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
            return []string{"table", "json", "yaml", "wide"}, cobra.ShellCompDirectiveNoFileComp
        })
}
```

## Section 4: Persistent Pre/Post Run Hook Patterns

```go
// cmd/hooks.go
package cmd

import (
    "fmt"
    "time"

    "github.com/spf13/cobra"
    "github.com/spf13/viper"
)

// WithAuthHook validates the auth token before running the command.
func WithAuthHook(runE func(cmd *cobra.Command, args []string) error) func(cmd *cobra.Command, args []string) error {
    return func(cmd *cobra.Command, args []string) error {
        token := viper.GetString("token")
        if token == "" {
            return fmt.Errorf("no authentication token found; run 'mycli login' or set MYCLI_TOKEN")
        }
        return runE(cmd, args)
    }
}

// TimedRunE wraps RunE with execution timing.
func TimedRunE(name string, runE func(cmd *cobra.Command, args []string) error) func(cmd *cobra.Command, args []string) error {
    return func(cmd *cobra.Command, args []string) error {
        start := time.Now()
        err := runE(cmd, args)
        if logger != nil {
            logger.Sugar().Infof("%s completed in %s", name, time.Since(start))
        }
        return err
    }
}

// ConfirmPrompt asks for interactive confirmation.
func ConfirmPrompt(cmd *cobra.Command, msg string) (bool, error) {
    if force, _ := cmd.Flags().GetBool("force"); force {
        return true, nil
    }
    fmt.Fprintf(cmd.OutOrStdout(), "%s [y/N]: ", msg)
    var input string
    if _, err := fmt.Fscan(cmd.InOrStdin(), &input); err != nil {
        return false, err
    }
    return input == "y" || input == "Y" || input == "yes", nil
}
```

## Section 5: Shell Completion Command

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

Bash (Linux):
  mycli completion bash > /etc/bash_completion.d/mycli

Zsh:
  mycli completion zsh > "${fpath[1]}/_mycli"

Fish:
  mycli completion fish > ~/.config/fish/completions/mycli.fish

PowerShell:
  mycli completion powershell | Out-String | Invoke-Expression
`,
    ValidArgs: []string{"bash", "zsh", "fish", "powershell"},
    Args:      cobra.MatchAll(cobra.ExactArgs(1), cobra.OnlyValidArgs),
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

func init() {
    rootCmd.AddCommand(completionCmd)
}
```

## Section 6: Plugin Architecture via PATH Discovery

Kubectl's plugin model — discover executables named `mycli-*` on PATH and delegate to them — is elegant and extensible:

```go
// internal/plugin/plugin.go
package plugin

import (
    "io/fs"
    "os"
    "os/exec"
    "path/filepath"
    "strings"
    "syscall"
)

const PluginPrefix = "mycli-"

type Plugin struct {
    Name string
    Path string
}

// Discover scans PATH for executables matching the plugin prefix.
func Discover() ([]Plugin, error) {
    pathDirs := filepath.SplitList(os.Getenv("PATH"))
    seen := map[string]bool{}
    var plugins []Plugin

    for _, dir := range pathDirs {
        entries, err := os.ReadDir(dir)
        if err != nil {
            continue
        }
        for _, entry := range entries {
            if !isExecutable(entry) {
                continue
            }
            name := entry.Name()
            if !strings.HasPrefix(name, PluginPrefix) {
                continue
            }
            pluginName := strings.TrimPrefix(name, PluginPrefix)
            pluginName = strings.ReplaceAll(pluginName, "-", " ")

            absPath := filepath.Join(dir, name)
            if seen[absPath] {
                continue
            }
            seen[absPath] = true
            plugins = append(plugins, Plugin{Name: pluginName, Path: absPath})
        }
    }
    return plugins, nil
}

func isExecutable(entry fs.DirEntry) bool {
    if entry.IsDir() {
        return false
    }
    info, err := entry.Info()
    if err != nil {
        return false
    }
    return info.Mode()&0111 != 0
}

// ExecPlugin replaces the current process with the plugin binary using syscall.Exec.
func ExecPlugin(p Plugin, args []string) error {
    pluginArgs := append([]string{p.Path}, args...)
    return syscall.Exec(p.Path, pluginArgs, os.Environ())
}

// RunPlugin executes the plugin as a subprocess inheriting stdio.
func RunPlugin(p Plugin, args []string) error {
    cmd := exec.Command(p.Path, args...)
    cmd.Stdin = os.Stdin
    cmd.Stdout = os.Stdout
    cmd.Stderr = os.Stderr
    cmd.Env = os.Environ()
    return cmd.Run()
}

// FindPlugin searches for a plugin matching the command chain using longest-match.
func FindPlugin(args []string) (*Plugin, []string, error) {
    plugins, err := Discover()
    if err != nil {
        return nil, nil, err
    }

    pluginMap := make(map[string]Plugin, len(plugins))
    for _, p := range plugins {
        pluginMap[p.Name] = p
    }

    for i := len(args); i > 0; i-- {
        candidate := strings.Join(args[:i], " ")
        if p, ok := pluginMap[candidate]; ok {
            return &p, args[i:], nil
        }
    }
    return nil, nil, nil
}
```

```go
// cmd/plugin.go
package cmd

import (
    "fmt"
    "text/tabwriter"

    "github.com/myorg/mycli/internal/plugin"
    "github.com/spf13/cobra"
)

var pluginCmd = &cobra.Command{
    Use:   "plugin",
    Short: "Manage and list mycli plugins",
}

var pluginListCmd = &cobra.Command{
    Use:   "list",
    Short: "List installed plugins",
    RunE: func(cmd *cobra.Command, args []string) error {
        plugins, err := plugin.Discover()
        if err != nil {
            return fmt.Errorf("discovering plugins: %w", err)
        }
        if len(plugins) == 0 {
            fmt.Fprintln(cmd.OutOrStdout(), "No plugins installed.")
            return nil
        }
        w := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 8, 2, ' ', 0)
        fmt.Fprintln(w, "NAME\tPATH")
        for _, p := range plugins {
            fmt.Fprintf(w, "%s\t%s\n", p.Name, p.Path)
        }
        return w.Flush()
    },
}

func init() {
    pluginCmd.AddCommand(pluginListCmd)
    rootCmd.AddCommand(pluginCmd)
}

func tryPlugin(args []string) error {
    p, remainingArgs, err := plugin.FindPlugin(args)
    if err != nil {
        return fmt.Errorf("plugin discovery failed: %w", err)
    }
    if p == nil {
        return fmt.Errorf("unknown command %q for mycli\n\nRun 'mycli --help' for usage", args[0])
    }
    return plugin.ExecPlugin(*p, remainingArgs)
}
```

## Section 7: Output Formatting — Table, JSON, YAML

```go
// internal/output/printer.go
package output

import (
    "encoding/json"
    "fmt"
    "io"
    "text/tabwriter"

    "github.com/olekukonko/tablewriter"
    "gopkg.in/yaml.v3"
)

type Printer interface {
    PrintResources(w io.Writer, resources []Resource) error
}

type Resource struct {
    Name      string            `json:"name" yaml:"name"`
    Namespace string            `json:"namespace" yaml:"namespace"`
    Status    string            `json:"status" yaml:"status"`
    Age       string            `json:"age" yaml:"age"`
    Labels    map[string]string `json:"labels,omitempty" yaml:"labels,omitempty"`
}

func NewPrinter(format string) (Printer, error) {
    switch format {
    case "table", "wide", "":
        return &TablePrinter{wide: format == "wide"}, nil
    case "json":
        return &JSONPrinter{}, nil
    case "yaml":
        return &YAMLPrinter{}, nil
    default:
        return nil, fmt.Errorf("unknown output format %q; supported: table, wide, json, yaml", format)
    }
}

type TablePrinter struct{ wide bool }

func (p *TablePrinter) PrintResources(w io.Writer, resources []Resource) error {
    table := tablewriter.NewWriter(w)
    if p.wide {
        table.SetHeader([]string{"NAME", "NAMESPACE", "STATUS", "AGE", "LABELS"})
    } else {
        table.SetHeader([]string{"NAME", "NAMESPACE", "STATUS", "AGE"})
    }
    table.SetBorder(false)
    table.SetHeaderAlignment(tablewriter.ALIGN_LEFT)
    table.SetAlignment(tablewriter.ALIGN_LEFT)
    table.SetCenterSeparator("")
    table.SetColumnSeparator("  ")
    table.SetRowSeparator("")
    table.SetHeaderLine(false)
    table.SetTablePadding("  ")
    table.SetNoWhiteSpace(true)

    for _, r := range resources {
        row := []string{r.Name, r.Namespace, r.Status, r.Age}
        if p.wide {
            labelStr := ""
            for k, v := range r.Labels {
                if labelStr != "" {
                    labelStr += ","
                }
                labelStr += k + "=" + v
            }
            row = append(row, labelStr)
        }
        table.Append(row)
    }
    table.Render()
    return nil
}

type JSONPrinter struct{}

func (p *JSONPrinter) PrintResources(w io.Writer, resources []Resource) error {
    enc := json.NewEncoder(w)
    enc.SetIndent("", "  ")
    return enc.Encode(resources)
}

type YAMLPrinter struct{}

func (p *YAMLPrinter) PrintResources(w io.Writer, resources []Resource) error {
    return yaml.NewEncoder(w).Encode(resources)
}

func WriteTabular(w io.Writer, rows [][2]string) {
    tw := tabwriter.NewWriter(w, 0, 8, 2, ' ', 0)
    for _, row := range rows {
        fmt.Fprintf(tw, "%s\t%s\n", row[0], row[1])
    }
    tw.Flush()
}
```

## Section 8: GoReleaser Configuration

```yaml
# .goreleaser.yaml
version: 2

before:
  hooks:
    - go mod tidy
    - go generate ./...

builds:
  - id: mycli
    main: ./main.go
    binary: mycli
    env:
      - CGO_ENABLED=0
    goos:
      - linux
      - darwin
      - windows
    goarch:
      - amd64
      - arm64
    flags:
      - -trimpath
    ldflags:
      - -s -w
      - -X github.com/myorg/mycli/cmd.version={{.Version}}
      - -X github.com/myorg/mycli/cmd.commit={{.Commit}}
      - -X github.com/myorg/mycli/cmd.date={{.Date}}
      - -X github.com/myorg/mycli/cmd.builtBy=goreleaser

archives:
  - id: default
    format: tar.gz
    format_overrides:
      - goos: windows
        format: zip
    name_template: "{{ .ProjectName }}_{{ .Version }}_{{ .Os }}_{{ .Arch }}"
    files:
      - LICENSE
      - README.md
      - completions/*

checksum:
  name_template: "checksums.txt"

changelog:
  sort: asc
  use: github
  groups:
    - title: Features
      regexp: "^.*feat[(\\w)]*:+.*$"
      order: 0
    - title: "Bug Fixes"
      regexp: "^.*fix[(\\w)]*:+.*$"
      order: 1
    - title: Others
      order: 999

brews:
  - name: mycli
    homepage: https://github.com/myorg/mycli
    description: "mycli — infrastructure CLI"
    license: Apache-2.0
    folder: Formula
    repository:
      owner: myorg
      name: homebrew-tap
      branch: main
    install: |
      bin.install "mycli"
      bash_completion.install "completions/mycli.bash" => "mycli"
      zsh_completion.install "completions/mycli.zsh" => "_mycli"
      fish_completion.install "completions/mycli.fish"
    test: |
      system "#{bin}/mycli", "version"

nfpms:
  - package_name: mycli
    homepage: https://github.com/myorg/mycli
    maintainer: MyOrg <engineering@myorg.com>
    description: "mycli — infrastructure CLI"
    license: Apache-2.0
    formats:
      - deb
      - rpm
      - apk
    bindir: /usr/bin
    contents:
      - src: completions/mycli.bash
        dst: /etc/bash_completion.d/mycli
      - src: completions/mycli.zsh
        dst: /usr/share/zsh/site-functions/_mycli
```

## Section 9: Version Command with Build Metadata

```go
// cmd/version.go
package cmd

import (
    "fmt"
    "runtime"

    "github.com/spf13/cobra"
)

var (
    version = "dev"
    commit  = "none"
    date    = "unknown"
    builtBy = "local"
)

type versionInfo struct {
    Version   string `json:"version" yaml:"version"`
    Commit    string `json:"commit" yaml:"commit"`
    Date      string `json:"date" yaml:"date"`
    BuiltBy   string `json:"builtBy" yaml:"builtBy"`
    GoVersion string `json:"goVersion" yaml:"goVersion"`
    Platform  string `json:"platform" yaml:"platform"`
}

func currentVersion() versionInfo {
    return versionInfo{
        Version:   version,
        Commit:    commit,
        Date:      date,
        BuiltBy:   builtBy,
        GoVersion: runtime.Version(),
        Platform:  fmt.Sprintf("%s/%s", runtime.GOOS, runtime.GOARCH),
    }
}

var versionCmd = &cobra.Command{
    Use:   "version",
    Short: "Print version information",
    RunE: func(cmd *cobra.Command, args []string) error {
        v := currentVersion()
        switch outputFmt {
        case "json":
            enc := json.NewEncoder(cmd.OutOrStdout())
            enc.SetIndent("", "  ")
            return enc.Encode(v)
        default:
            fmt.Fprintf(cmd.OutOrStdout(), "mycli version %s\n", v.Version)
            fmt.Fprintf(cmd.OutOrStdout(), "  commit:    %s\n", v.Commit)
            fmt.Fprintf(cmd.OutOrStdout(), "  date:      %s\n", v.Date)
            fmt.Fprintf(cmd.OutOrStdout(), "  go:        %s\n", v.GoVersion)
            fmt.Fprintf(cmd.OutOrStdout(), "  platform:  %s\n", v.Platform)
        }
        return nil
    },
}

func init() {
    rootCmd.AddCommand(versionCmd)
}
```

## Section 10: Testing CLI Commands

Testing Cobra commands without spawning subprocesses — inject stdin/stdout and run commands programmatically:

```go
// cmd/resource/list_test.go
package resource_test

import (
    "bytes"
    "encoding/json"
    "testing"

    "github.com/myorg/mycli/cmd"
    "github.com/myorg/mycli/internal/client"
    "github.com/myorg/mycli/internal/output"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

func executeCommand(args ...string) (string, string, error) {
    buf := new(bytes.Buffer)
    errBuf := new(bytes.Buffer)

    root := cmd.NewRootCmd()
    root.SetOut(buf)
    root.SetErr(errBuf)
    root.SetArgs(args)

    err := root.Execute()
    return buf.String(), errBuf.String(), err
}

func TestResourceListTableOutput(t *testing.T) {
    client.SetMockClient(&client.MockClient{
        Resources: []output.Resource{
            {Name: "pod-alpha", Namespace: "default", Status: "Running", Age: "2d"},
            {Name: "pod-beta", Namespace: "default", Status: "Pending", Age: "5m"},
        },
    })

    stdout, _, err := executeCommand("resource", "list", "-n", "default")
    require.NoError(t, err)

    assert.Contains(t, stdout, "pod-alpha")
    assert.Contains(t, stdout, "pod-beta")
    assert.Contains(t, stdout, "Running")
    assert.Contains(t, stdout, "Pending")
}

func TestResourceListJSONOutput(t *testing.T) {
    client.SetMockClient(&client.MockClient{
        Resources: []output.Resource{
            {Name: "pod-alpha", Namespace: "default", Status: "Running", Age: "2d"},
        },
    })

    stdout, _, err := executeCommand("resource", "list", "-o", "json")
    require.NoError(t, err)

    var resources []output.Resource
    require.NoError(t, json.Unmarshal([]byte(stdout), &resources))
    require.Len(t, resources, 1)
    assert.Equal(t, "pod-alpha", resources[0].Name)
}

func TestResourceListValidationError(t *testing.T) {
    _, _, err := executeCommand("resource", "list", "--page-size", "9999")
    require.Error(t, err)
    assert.Contains(t, err.Error(), "page-size")
}

func TestResourceListMutuallyExclusiveFlags(t *testing.T) {
    _, _, err := executeCommand("resource", "list", "-n", "default", "--all-namespaces")
    require.Error(t, err)
    assert.Contains(t, err.Error(), "mutually exclusive")
}

func TestVersionCommandText(t *testing.T) {
    stdout, _, err := executeCommand("version")
    require.NoError(t, err)
    assert.Contains(t, stdout, "mycli version")
    assert.Contains(t, stdout, "go:")
    assert.Contains(t, stdout, "platform:")
}

func TestCompletionBash(t *testing.T) {
    stdout, _, err := executeCommand("completion", "bash")
    require.NoError(t, err)
    assert.Contains(t, stdout, "bash")
    assert.NotEmpty(t, stdout)
}
```

## Section 11: Config File Management

```go
// cmd/config/config.go
package config

import (
    "fmt"
    "os"
    "path/filepath"

    "github.com/spf13/cobra"
    "github.com/spf13/viper"
    "gopkg.in/yaml.v3"
)

var ConfigCmd = &cobra.Command{
    Use:   "config",
    Short: "Manage mycli configuration",
}

var getCmd = &cobra.Command{
    Use:   "get [key]",
    Short: "Get a configuration value",
    Args:  cobra.MaximumNArgs(1),
    RunE: func(cmd *cobra.Command, args []string) error {
        if len(args) == 0 {
            settings := viper.AllSettings()
            enc := yaml.NewEncoder(cmd.OutOrStdout())
            return enc.Encode(settings)
        }
        key := args[0]
        val := viper.Get(key)
        if val == nil {
            return fmt.Errorf("key %q not found in config", key)
        }
        fmt.Fprintln(cmd.OutOrStdout(), val)
        return nil
    },
}

var setCmd = &cobra.Command{
    Use:   "set <key> <value>",
    Short: "Set a configuration value",
    Args:  cobra.ExactArgs(2),
    RunE: func(cmd *cobra.Command, args []string) error {
        key, value := args[0], args[1]
        viper.Set(key, value)
        return writeConfig()
    },
}

var viewCmd = &cobra.Command{
    Use:   "view",
    Short: "Show the config file path and its contents",
    RunE: func(cmd *cobra.Command, args []string) error {
        cfgFile := viper.ConfigFileUsed()
        if cfgFile == "" {
            fmt.Fprintln(cmd.OutOrStdout(), "No config file loaded.")
            return nil
        }
        fmt.Fprintf(cmd.OutOrStdout(), "Config file: %s\n\n", cfgFile)
        data, err := os.ReadFile(cfgFile)
        if err != nil {
            return err
        }
        fmt.Fprintln(cmd.OutOrStdout(), string(data))
        return nil
    },
}

func writeConfig() error {
    cfgFile := viper.ConfigFileUsed()
    if cfgFile == "" {
        home, _ := os.UserHomeDir()
        cfgFile = filepath.Join(home, ".mycli", "config.yaml")
        if err := os.MkdirAll(filepath.Dir(cfgFile), 0700); err != nil {
            return err
        }
    }
    return viper.WriteConfigAs(cfgFile)
}

func init() {
    ConfigCmd.AddCommand(getCmd, setCmd, viewCmd)
}
```

## Section 12: Makefile for Developer Workflow

```makefile
BINARY      := mycli
VERSION     ?= $(shell git describe --tags --always --dirty)
COMMIT      := $(shell git rev-parse --short HEAD)
DATE        := $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
LDFLAGS     := -s -w \
               -X github.com/myorg/mycli/cmd.version=$(VERSION) \
               -X github.com/myorg/mycli/cmd.commit=$(COMMIT) \
               -X github.com/myorg/mycli/cmd.date=$(DATE)

.PHONY: build test lint completions install release

build:
	CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o bin/$(BINARY) ./main.go

test:
	go test -race -coverprofile=coverage.out ./...
	go tool cover -html=coverage.out -o coverage.html

lint:
	golangci-lint run ./...

completions: build
	mkdir -p completions
	./bin/$(BINARY) completion bash > completions/$(BINARY).bash
	./bin/$(BINARY) completion zsh  > completions/$(BINARY).zsh
	./bin/$(BINARY) completion fish > completions/$(BINARY).fish

install: build
	install -m 0755 bin/$(BINARY) /usr/local/bin/$(BINARY)

release:
	goreleaser release --clean
```

Building a production-quality Go CLI with Cobra requires deliberate choices about flag inheritance, completion registration, plugin delegation, and output formatting. The patterns in this guide are drawn from kubectl and helm — tools that millions of operators use daily — and adapted for your own infrastructure tooling.
