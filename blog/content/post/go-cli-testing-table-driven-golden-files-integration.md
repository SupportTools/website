---
title: "Go CLI Testing: Table-Driven Tests, Golden Files, and Integration Testing"
date: 2029-02-05T00:00:00-05:00
draft: false
tags: ["Go", "Testing", "CLI", "Cobra", "Integration Testing"]
categories:
- Go
- Testing
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to testing Go CLI applications built with Cobra, covering table-driven unit tests, golden file testing for output validation, integration test patterns with real processes, and CI/CD integration strategies."
more_link: "yes"
url: "/go-cli-testing-table-driven-golden-files-integration/"
---

CLI application testing is frequently underdeveloped compared to service testing. The testing surface covers argument parsing, flag validation, command execution logic, stdout/stderr output format, exit codes, and side effects like file system changes or API calls. Each of these requires a different testing strategy, and combining them correctly prevents regressions in CLI tools that teams depend on daily.

This guide covers the complete Go CLI testing stack: table-driven tests for command logic, golden file testing for output stability, integration tests that run the compiled binary, and patterns for testing commands with external dependencies.

<!--more-->

## CLI Application Structure

A well-structured Cobra-based CLI separates command registration from command execution logic, making both individually testable.

```go
// cmd/root.go
package cmd

import (
	"fmt"
	"io"
	"os"

	"github.com/spf13/cobra"
	"github.com/spf13/viper"
)

// App holds all CLI dependencies — passed to commands for testability
type App struct {
	Out    io.Writer
	ErrOut io.Writer
	Config *viper.Viper
	Client APIClient
}

func NewApp(out, errOut io.Writer) *App {
	v := viper.New()
	v.SetEnvPrefix("PLATFORM")
	v.AutomaticEnv()
	return &App{
		Out:    out,
		ErrOut: errOut,
		Config: v,
	}
}

func NewRootCmd(app *App) *cobra.Command {
	var cfgFile string

	root := &cobra.Command{
		Use:   "platform",
		Short: "Platform engineering CLI tool",
		Long: `platform is the CLI for the company engineering platform.
It provides commands for managing services, secrets, and deployments.`,
		SilenceUsage:  true,
		SilenceErrors: true,
		PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
			if cfgFile != "" {
				app.Config.SetConfigFile(cfgFile)
				if err := app.Config.ReadInConfig(); err != nil {
					return fmt.Errorf("reading config: %w", err)
				}
			}
			return nil
		},
	}

	root.PersistentFlags().StringVar(&cfgFile, "config", "", "config file (default: $HOME/.platform.yaml)")
	root.PersistentFlags().String("output", "text", "output format: text, json, yaml")
	app.Config.BindPFlag("output", root.PersistentFlags().Lookup("output"))

	root.AddCommand(
		NewServiceCmd(app),
		NewSecretCmd(app),
		NewDeployCmd(app),
	)

	return root
}

// Execute is the main entry point — thin wrapper around NewRootCmd
func Execute() {
	app := NewApp(os.Stdout, os.Stderr)
	root := NewRootCmd(app)
	if err := root.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
```

## Service Command with Testable Design

```go
// cmd/service.go
package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"
)

type Service struct {
	Name      string    `json:"name"`
	Namespace string    `json:"namespace"`
	Status    string    `json:"status"`
	Replicas  int       `json:"replicas"`
	Ready     int       `json:"ready"`
	CreatedAt time.Time `json:"created_at"`
}

type APIClient interface {
	ListServices(ctx context.Context, namespace string) ([]Service, error)
	GetService(ctx context.Context, namespace, name string) (*Service, error)
	ScaleService(ctx context.Context, namespace, name string, replicas int) error
}

func NewServiceCmd(app *App) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "service",
		Short: "Manage platform services",
	}

	cmd.AddCommand(
		newServiceListCmd(app),
		newServiceGetCmd(app),
		newServiceScaleCmd(app),
	)

	return cmd
}

func newServiceListCmd(app *App) *cobra.Command {
	var namespace string
	var showAll bool

	cmd := &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List services in a namespace",
		Example: `  platform service list --namespace payments
  platform service list -n payments -o json`,
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			services, err := app.Client.ListServices(ctx, namespace)
			if err != nil {
				return fmt.Errorf("listing services: %w", err)
			}

			if !showAll {
				filtered := make([]Service, 0, len(services))
				for _, s := range services {
					if s.Status != "deprecated" {
						filtered = append(filtered, s)
					}
				}
				services = filtered
			}

			outputFmt := app.Config.GetString("output")
			return renderServices(app.Out, services, outputFmt)
		},
	}

	cmd.Flags().StringVarP(&namespace, "namespace", "n", "default", "namespace to list services in")
	cmd.Flags().BoolVarP(&showAll, "all", "a", false, "show all services including deprecated")

	return cmd
}

func renderServices(out interface{ Write([]byte) (int, error) }, services []Service, format string) error {
	switch format {
	case "json":
		enc := json.NewEncoder(out)
		enc.SetIndent("", "  ")
		return enc.Encode(services)
	case "yaml":
		// yaml rendering here
		return fmt.Errorf("yaml output not yet implemented")
	default: // text
		w := tabwriter.NewWriter(out, 0, 0, 3, ' ', 0)
		fmt.Fprintln(w, "NAME\tNAMESPACE\tSTATUS\tREADY\tAGE")
		for _, s := range services {
			age := time.Since(s.CreatedAt).Round(time.Minute)
			fmt.Fprintf(w, "%s\t%s\t%s\t%d/%d\t%s\n",
				s.Name, s.Namespace, s.Status, s.Ready, s.Replicas, age)
		}
		return w.Flush()
	}
}
```

## Table-Driven Unit Tests

```go
// cmd/service_test.go
package cmd_test

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/company/platform/cmd"
)

// mockAPIClient implements cmd.APIClient for testing
type mockAPIClient struct {
	services map[string][]cmd.Service
	err      error
}

func (m *mockAPIClient) ListServices(ctx context.Context, namespace string) ([]cmd.Service, error) {
	if m.err != nil {
		return nil, m.err
	}
	return m.services[namespace], nil
}

func (m *mockAPIClient) GetService(ctx context.Context, namespace, name string) (*cmd.Service, error) {
	if m.err != nil {
		return nil, m.err
	}
	for _, s := range m.services[namespace] {
		if s.Name == name {
			return &s, nil
		}
	}
	return nil, errors.New("service not found")
}

func (m *mockAPIClient) ScaleService(ctx context.Context, namespace, name string, replicas int) error {
	return m.err
}

var testServices = []cmd.Service{
	{
		Name:      "payments-api",
		Namespace: "payments",
		Status:    "running",
		Replicas:  3,
		Ready:     3,
		CreatedAt: time.Date(2029, 1, 15, 10, 0, 0, 0, time.UTC),
	},
	{
		Name:      "payments-worker",
		Namespace: "payments",
		Status:    "running",
		Replicas:  5,
		Ready:     4,
		CreatedAt: time.Date(2029, 1, 10, 8, 0, 0, 0, time.UTC),
	},
	{
		Name:      "payments-legacy",
		Namespace: "payments",
		Status:    "deprecated",
		Replicas:  1,
		Ready:     1,
		CreatedAt: time.Date(2028, 6, 1, 0, 0, 0, 0, time.UTC),
	},
}

func TestServiceList(t *testing.T) {
	tests := []struct {
		name          string
		args          []string
		mockServices  []cmd.Service
		mockErr       error
		wantErr       bool
		wantErrString string
		wantInOutput  []string
		wantNotOutput []string
		wantExitCode  int
	}{
		{
			name:         "list services in namespace",
			args:         []string{"service", "list", "--namespace", "payments"},
			mockServices: testServices,
			wantInOutput: []string{"payments-api", "payments-worker", "NAME", "NAMESPACE"},
			// deprecated services filtered by default
			wantNotOutput: []string{"payments-legacy"},
		},
		{
			name:         "list all services including deprecated",
			args:         []string{"service", "list", "-n", "payments", "--all"},
			mockServices: testServices,
			wantInOutput: []string{"payments-api", "payments-worker", "payments-legacy"},
		},
		{
			name:         "json output format",
			args:         []string{"service", "list", "-n", "payments", "--output", "json"},
			mockServices: testServices,
			wantInOutput: []string{`"name": "payments-api"`, `"status": "running"`},
		},
		{
			name:          "api error returns error",
			args:          []string{"service", "list", "-n", "payments"},
			mockErr:       errors.New("connection refused"),
			wantErr:       true,
			wantErrString: "connection refused",
		},
		{
			name:         "empty namespace returns empty list",
			args:         []string{"service", "list", "-n", "nonexistent"},
			mockServices: []cmd.Service{},
			wantInOutput: []string{"NAME"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var out, errOut bytes.Buffer

			app := cmd.NewApp(&out, &errOut)
			app.Client = &mockAPIClient{
				services: map[string][]cmd.Service{
					"payments": tt.mockServices,
				},
				err: tt.mockErr,
			}

			root := cmd.NewRootCmd(app)
			root.SetArgs(tt.args)
			root.SetOut(&out)
			root.SetErr(&errOut)

			err := root.Execute()

			if (err != nil) != tt.wantErr {
				t.Errorf("Execute() error = %v, wantErr %v", err, tt.wantErr)
				return
			}

			if tt.wantErrString != "" && err != nil {
				if !strings.Contains(err.Error(), tt.wantErrString) {
					t.Errorf("error %q does not contain %q", err.Error(), tt.wantErrString)
				}
			}

			output := out.String()
			for _, want := range tt.wantInOutput {
				if !strings.Contains(output, want) {
					t.Errorf("output does not contain %q\nfull output:\n%s", want, output)
				}
			}

			for _, notWant := range tt.wantNotOutput {
				if strings.Contains(output, notWant) {
					t.Errorf("output should not contain %q\nfull output:\n%s", notWant, output)
				}
			}
		})
	}
}
```

## Golden File Testing

Golden files capture the exact expected output of a command, stored in `testdata/golden/` files. On first run with `-update`, they create the files. Subsequent runs compare output against the stored baseline.

```go
// internal/testutil/golden.go
package testutil

import (
	"bytes"
	"flag"
	"os"
	"path/filepath"
	"testing"
)

var update = flag.Bool("update", false, "update golden files")

// AssertGoldenFile compares actual output to a stored golden file.
// Run with -update to update the golden files.
func AssertGoldenFile(t *testing.T, name string, actual []byte) {
	t.Helper()

	goldenPath := filepath.Join("testdata", "golden", name+".golden")

	if *update {
		if err := os.MkdirAll(filepath.Dir(goldenPath), 0755); err != nil {
			t.Fatalf("creating golden dir: %v", err)
		}
		if err := os.WriteFile(goldenPath, actual, 0644); err != nil {
			t.Fatalf("writing golden file: %v", err)
		}
		t.Logf("updated golden file: %s", goldenPath)
		return
	}

	expected, err := os.ReadFile(goldenPath)
	if err != nil {
		t.Fatalf("reading golden file %s: %v\nRun with -update to create it", goldenPath, err)
	}

	if !bytes.Equal(expected, actual) {
		t.Errorf("golden file mismatch for %s\nexpected:\n%s\nactual:\n%s",
			name, expected, actual)
	}
}
```

```go
// cmd/service_golden_test.go
package cmd_test

import (
	"bytes"
	"testing"
	"time"

	"github.com/company/platform/cmd"
	"github.com/company/platform/internal/testutil"
)

func TestServiceListGolden(t *testing.T) {
	tests := []struct {
		name       string
		args       []string
		goldenFile string
	}{
		{
			name:       "default text output",
			args:       []string{"service", "list", "-n", "payments"},
			goldenFile: "service-list-text",
		},
		{
			name:       "json output",
			args:       []string{"service", "list", "-n", "payments", "--output", "json"},
			goldenFile: "service-list-json",
		},
		{
			name:       "all services including deprecated",
			args:       []string{"service", "list", "-n", "payments", "--all"},
			goldenFile: "service-list-all",
		},
	}

	// Fixed time for reproducible golden files
	fixedTime := time.Date(2029, 2, 5, 12, 0, 0, 0, time.UTC)

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var out bytes.Buffer

			app := cmd.NewApp(&out, &bytes.Buffer{})
			app.Client = &mockAPIClient{
				services: map[string][]cmd.Service{
					"payments": {
						{
							Name:      "payments-api",
							Namespace: "payments",
							Status:    "running",
							Replicas:  3,
							Ready:     3,
							CreatedAt: fixedTime.Add(-360 * time.Hour), // 15 days ago
						},
						{
							Name:      "payments-worker",
							Namespace: "payments",
							Status:    "running",
							Replicas:  5,
							Ready:     5,
							CreatedAt: fixedTime.Add(-720 * time.Hour), // 30 days ago
						},
					},
				},
			}

			root := cmd.NewRootCmd(app)
			root.SetArgs(tt.args)
			root.SetOut(&out)

			if err := root.Execute(); err != nil {
				t.Fatalf("Execute() failed: %v", err)
			}

			testutil.AssertGoldenFile(t, tt.goldenFile, out.Bytes())
		})
	}
}
```

```
# testdata/golden/service-list-text.golden
NAME             NAMESPACE   STATUS    READY   AGE
payments-api     payments    running   3/3     360h0m0s
payments-worker  payments    running   5/5     720h0m0s
```

## Integration Tests: Testing the Compiled Binary

Integration tests compile the binary and run it as a subprocess — the highest-fidelity tests for CLI behavior, including environment variable handling, config file loading, and exit codes.

```go
// integration/cli_test.go
//go:build integration

package integration_test

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

var binaryPath string

func TestMain(m *testing.M) {
	// Build the binary before running tests
	tmp, err := os.MkdirTemp("", "platform-cli-test-*")
	if err != nil {
		panic(err)
	}
	defer os.RemoveAll(tmp)

	ext := ""
	if runtime.GOOS == "windows" {
		ext = ".exe"
	}

	binaryPath = filepath.Join(tmp, "platform"+ext)

	build := exec.Command("go", "build",
		"-o", binaryPath,
		"./cmd/platform",
	)
	build.Dir = projectRoot()
	if out, err := build.CombinedOutput(); err != nil {
		panic("failed to build CLI: " + string(out))
	}

	os.Exit(m.Run())
}

func projectRoot() string {
	// Walk up from current test file until we find go.mod
	_, filename, _, _ := runtime.Caller(0)
	dir := filepath.Dir(filename)
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			panic("could not find project root")
		}
		dir = parent
	}
}

// runCLI runs the CLI binary with given args and returns stdout, stderr, and error
func runCLI(t *testing.T, env []string, args ...string) (string, string, error) {
	t.Helper()
	cmd := exec.Command(binaryPath, args...)
	cmd.Env = append(os.Environ(), env...)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	return stdout.String(), stderr.String(), err
}

func TestVersionCommand(t *testing.T) {
	stdout, _, err := runCLI(t, nil, "version")
	if err != nil {
		t.Fatalf("version command failed: %v", err)
	}
	if !strings.Contains(stdout, "platform") {
		t.Errorf("version output does not contain 'platform': %q", stdout)
	}
}

func TestHelpOutput(t *testing.T) {
	stdout, _, err := runCLI(t, nil, "--help")
	if err != nil {
		t.Fatalf("help failed: %v", err)
	}
	for _, expect := range []string{"service", "secret", "deploy", "Usage:"} {
		if !strings.Contains(stdout, expect) {
			t.Errorf("help output missing %q", expect)
		}
	}
}

func TestServiceListJSONOutput(t *testing.T) {
	// Requires a running test API server (set up in TestMain or using httptest)
	if os.Getenv("PLATFORM_API_URL") == "" {
		t.Skip("PLATFORM_API_URL not set, skipping integration test")
	}

	stdout, _, err := runCLI(t,
		[]string{"PLATFORM_API_URL=" + os.Getenv("PLATFORM_API_URL")},
		"service", "list", "--namespace", "test", "--output", "json",
	)
	if err != nil {
		t.Fatalf("service list failed: %v", err)
	}

	var services []map[string]interface{}
	if err := json.Unmarshal([]byte(stdout), &services); err != nil {
		t.Fatalf("output is not valid JSON: %v\noutput: %q", err, stdout)
	}
	if len(services) == 0 {
		t.Error("expected at least one service")
	}
}

func TestExitCodes(t *testing.T) {
	tests := []struct {
		name     string
		args     []string
		wantCode int
	}{
		{
			name:     "unknown command returns exit 1",
			args:     []string{"nonexistent-command"},
			wantCode: 1,
		},
		{
			name:     "help returns exit 0",
			args:     []string{"--help"},
			wantCode: 0,
		},
		{
			name:     "invalid flag returns exit 1",
			args:     []string{"service", "list", "--invalid-flag"},
			wantCode: 1,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, _, err := runCLI(t, nil, tt.args...)

			exitCode := 0
			if err != nil {
				if exitErr, ok := err.(*exec.ExitError); ok {
					exitCode = exitErr.ExitCode()
				} else {
					t.Fatalf("unexpected error type: %v", err)
				}
			}

			if exitCode != tt.wantCode {
				t.Errorf("exit code = %d, want %d", exitCode, tt.wantCode)
			}
		})
	}
}
```

## Testing Commands with Filesystem Side Effects

```go
// cmd/config_test.go
package cmd_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/company/platform/cmd"
)

func TestConfigInit(t *testing.T) {
	// Create a temp home directory to isolate filesystem operations
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	var out, errOut bytes.Buffer
	app := cmd.NewApp(&out, &errOut)
	root := cmd.NewRootCmd(app)
	root.SetArgs([]string{"config", "init"})

	if err := root.Execute(); err != nil {
		t.Fatalf("config init failed: %v", err)
	}

	// Verify the config file was created
	configPath := filepath.Join(tmpHome, ".platform.yaml")
	if _, err := os.Stat(configPath); os.IsNotExist(err) {
		t.Errorf("expected config file at %s, but it was not created", configPath)
	}

	content, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("reading config: %v", err)
	}

	if !strings.Contains(string(content), "output: text") {
		t.Errorf("config missing default output setting: %s", content)
	}
}
```

## CI/CD Integration

```yaml
# .github/workflows/test.yaml
name: Test

on:
  push:
    branches: [main]
  pull_request:

jobs:
  unit-tests:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: "1.23"
          cache: true
      - name: Run unit tests
        run: |
          go test ./cmd/... ./internal/... \
            -v \
            -race \
            -coverprofile=coverage.out \
            -covermode=atomic \
            -timeout=60s
      - name: Check coverage threshold
        run: |
          COVERAGE=$(go tool cover -func=coverage.out | grep total | awk '{print $3}' | tr -d '%')
          if (( $(echo "$COVERAGE < 80" | bc -l) )); then
            echo "Coverage ${COVERAGE}% below threshold 80%"
            exit 1
          fi
          echo "Coverage: ${COVERAGE}%"

  golden-file-check:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: "1.23"
          cache: true
      - name: Check golden files are up to date
        run: |
          go test ./cmd/... -run TestServiceListGolden -update
          git diff --exit-code testdata/golden/
          # If this fails, golden files are stale — run 'go test ./cmd/... -update' locally

  integration-tests:
    runs-on: ubuntu-24.04
    services:
      mock-api:
        image: registry.company.com/tests/mock-platform-api:latest
        ports:
          - 8080:8080
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: "1.23"
          cache: true
      - name: Run integration tests
        env:
          PLATFORM_API_URL: http://localhost:8080
        run: |
          go test ./integration/... \
            -tags integration \
            -v \
            -timeout=120s
```

Table-driven tests catch logic regressions, golden files catch output format regressions, and integration tests catch binary-level regressions including build errors, environment variable handling, and OS-specific behavior. Combining all three with a coverage gate provides confidence that CLI tools remain reliable across releases.
