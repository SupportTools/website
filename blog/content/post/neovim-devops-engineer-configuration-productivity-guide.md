---
title: "Neovim for DevOps Engineers: Complete Configuration and Productivity Guide"
date: 2026-12-25T00:00:00-05:00
draft: false
tags: ["Neovim", "DevOps", "Developer Productivity", "Terminal", "Vim", "LSP", "Configuration"]
categories:
- Developer Tooling
- Productivity
author: "Matthew Mattox - mmattox@support.tools"
description: "Practical Neovim configuration guide for DevOps engineers: LSP for Go/Python/YAML/Terraform, Telescope fuzzy finding, Kubernetes manifest editing, tmux integration, and custom automation workflows."
more_link: "yes"
url: "/neovim-devops-engineer-configuration-productivity-guide/"
---

**Neovim** occupies a unique position in the DevOps toolchain: it runs identically over SSH on a 10 Mbps connection to a remote jumphost, inside a tmux session split four ways, and in a local terminal with full LSP intelligence — all with the same configuration and muscle memory. For engineers who spend hours daily editing Kubernetes manifests, Terraform modules, Go tooling, and shell scripts across multiple remote systems, the investment in a well-configured Neovim pays continuous dividends that GUI-based IDEs cannot match when working on production infrastructure.

This guide builds a complete Neovim configuration targeting the specific workflows of platform and DevOps engineers: YAML with schema validation, Go with gopls, Terraform with terraform-ls, Telescope-driven file navigation across large monorepos, and custom keymaps that automate repetitive Kubernetes operations.

<!--more-->

## Why Neovim for Infrastructure Work

The case for Neovim in infrastructure roles is not about key bindings or editor philosophy — it is about operational efficiency under real conditions:

**SSH and remote editing**: Every cloud node, jumphost, and bastion is reachable by SSH. Neovim runs over any SSH connection with zero latency overhead. VS Code Remote SSH requires a server-side extension installation that fails on locked-down production nodes and adds 50-200ms per operation over high-latency connections.

**Terminal integration**: DevOps work is terminal-centric. Switching between a file editor and a terminal means a context switch that breaks flow. With Neovim inside tmux, editing a Terraform file and running `terraform plan` in an adjacent pane is a single key combination, with outputs visible simultaneously.

**Performance on large files**: Ansible playbooks, Kubernetes CRD manifests, and Helm chart values files routinely reach thousands of lines. Neovim handles these without the stuttering that many Electron-based editors exhibit above 5,000 lines.

**Scripted configuration**: Neovim's Lua configuration API is a proper programming language. Automating repetitive tasks — generating boilerplate ConfigMap entries, templating out Kubernetes resources, running linters on save — requires nothing beyond the built-in Lua runtime.

## Installation

```bash
#!/bin/bash
set -euo pipefail

# Install Neovim on Linux from tarball
NVIM_VERSION="0.10.3"
curl -LO "https://github.com/neovim/neovim/releases/download/v${NVIM_VERSION}/nvim-linux-x86_64.tar.gz"
tar -xzf "nvim-linux-x86_64.tar.gz"
sudo mv nvim-linux-x86_64 /opt/nvim
sudo ln -sf /opt/nvim/bin/nvim /usr/local/bin/nvim

# Install language servers
npm install -g yaml-language-server
pip3 install python-lsp-server
go install golang.org/x/tools/gopls@latest
terraform-ls --version || \
  (curl -Lo /tmp/terraform-ls.zip \
    "https://releases.hashicorp.com/terraform-ls/0.33.0/terraform-ls_0.33.0_linux_amd64.zip" \
   && unzip /tmp/terraform-ls.zip -d /usr/local/bin)
```

Place the Neovim configuration in `~/.config/nvim/`. The entry point is `init.lua`.

## Plugin Manager Setup with lazy.nvim

**lazy.nvim** is the current standard plugin manager for Neovim. It provides lazy loading (plugins load only when their file type or command is triggered), lockfile-based reproducibility, and a clean declarative API:

```lua
-- ~/.config/nvim/init.lua
-- Bootstrap lazy.nvim
local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"
if not vim.loop.fs_stat(lazypath) then
  vim.fn.system({
    "git", "clone", "--filter=blob:none",
    "https://github.com/folke/lazy.nvim.git",
    "--branch=stable",
    lazypath,
  })
end
vim.opt.rtp:prepend(lazypath)

-- Core settings before plugins load
vim.g.mapleader = " "
vim.g.maplocalleader = " "
vim.opt.number = true
vim.opt.relativenumber = true
vim.opt.tabstop = 2
vim.opt.shiftwidth = 2
vim.opt.expandtab = true
vim.opt.termguicolors = true
vim.opt.signcolumn = "yes"
vim.opt.updatetime = 250
vim.opt.timeoutlen = 300
vim.opt.undofile = true
vim.opt.ignorecase = true
vim.opt.smartcase = true
vim.opt.scrolloff = 8

-- Plugin declarations
require("lazy").setup({
  -- Colorscheme
  {
    "catppuccin/nvim",
    name = "catppuccin",
    priority = 1000,
    config = function()
      vim.cmd.colorscheme("catppuccin-mocha")
    end,
  },

  -- Status line
  { "nvim-lualine/lualine.nvim", dependencies = { "nvim-tree/nvim-web-devicons" } },

  -- LSP core
  { "neovim/nvim-lspconfig" },
  { "williamboman/mason.nvim" },
  { "williamboman/mason-lspconfig.nvim" },

  -- Completion
  {
    "hrsh7th/nvim-cmp",
    dependencies = {
      "hrsh7th/cmp-nvim-lsp",
      "hrsh7th/cmp-buffer",
      "hrsh7th/cmp-path",
      "L3MON4D3/LuaSnip",
      "saadparwaiz1/cmp_luasnip",
    },
  },

  -- Telescope
  {
    "nvim-telescope/telescope.nvim",
    tag = "0.1.8",
    dependencies = {
      "nvim-lua/plenary.nvim",
      { "nvim-telescope/telescope-fzf-native.nvim", build = "make" },
    },
  },

  -- TreeSitter
  {
    "nvim-treesitter/nvim-treesitter",
    build = ":TSUpdate",
    dependencies = { "nvim-treesitter/nvim-treesitter-textobjects" },
  },

  -- Git
  { "tpope/vim-fugitive" },
  { "lewis6991/gitsigns.nvim" },

  -- File explorer
  { "nvim-tree/nvim-tree.lua", dependencies = { "nvim-tree/nvim-web-devicons" } },

  -- YAML schema validation
  { "someone-stole-my-name/yaml-companion.nvim", dependencies = { "nvim-lua/plenary.nvim" } },

  -- Formatting
  { "stevearc/conform.nvim" },

  -- Diagnostics panel
  { "folke/trouble.nvim", dependencies = { "nvim-tree/nvim-web-devicons" } },

  -- Terminal
  { "akinsho/toggleterm.nvim", version = "*" },
})
```

## LSP Configuration

The **Language Server Protocol** integration is the centerpiece of Neovim's IDE-equivalent capability. Each language server provides type information, go-to-definition, find-references, hover documentation, and real-time diagnostics:

```lua
-- ~/.config/nvim/lua/lsp.lua
local mason = require("mason")
local mason_lspconfig = require("mason-lspconfig")
local lspconfig = require("lspconfig")
local cmp_nvim_lsp = require("cmp_nvim_lsp")

mason.setup({
  ui = { border = "rounded" },
})

mason_lspconfig.setup({
  ensure_installed = {
    "gopls",         -- Go
    "pyright",       -- Python
    "yamlls",        -- YAML (Kubernetes, Ansible, etc.)
    "terraformls",   -- Terraform
    "tflint",        -- Terraform linting
    "bashls",        -- Bash/shell scripts
    "jsonls",        -- JSON
    "dockerls",      -- Dockerfile
    "helm_ls",       -- Helm charts
  },
  automatic_installation = true,
})

local capabilities = cmp_nvim_lsp.default_capabilities()

-- Shared on_attach: keymaps applied to every LSP-attached buffer
local on_attach = function(_, bufnr)
  local opts = { buffer = bufnr, noremap = true, silent = true }
  vim.keymap.set("n", "gd",         vim.lsp.buf.definition,       opts)
  vim.keymap.set("n", "gD",         vim.lsp.buf.declaration,      opts)
  vim.keymap.set("n", "gi",         vim.lsp.buf.implementation,   opts)
  vim.keymap.set("n", "gr",         vim.lsp.buf.references,       opts)
  vim.keymap.set("n", "K",          vim.lsp.buf.hover,            opts)
  vim.keymap.set("n", "<leader>rn", vim.lsp.buf.rename,           opts)
  vim.keymap.set("n", "<leader>ca", vim.lsp.buf.code_action,      opts)
  vim.keymap.set("n", "<leader>d",  vim.diagnostic.open_float,    opts)
  vim.keymap.set("n", "[d",         vim.diagnostic.goto_prev,     opts)
  vim.keymap.set("n", "]d",         vim.diagnostic.goto_next,     opts)
end

-- Go: gopls with all analysis passes enabled
lspconfig.gopls.setup({
  capabilities = capabilities,
  on_attach = on_attach,
  settings = {
    gopls = {
      analyses = {
        unusedparams = true,
        shadow = true,
        nilness = true,
        useany = true,
      },
      staticcheck = true,
      gofumpt = true,
      usePlaceholders = true,
    },
  },
})

-- Python: Pyright for type checking
lspconfig.pyright.setup({
  capabilities = capabilities,
  on_attach = on_attach,
  settings = {
    python = {
      analysis = {
        typeCheckingMode = "basic",
        autoSearchPaths = true,
        useLibraryCodeForTypes = true,
      },
    },
  },
})

-- YAML: yamlls with Kubernetes schema
lspconfig.yamlls.setup({
  capabilities = capabilities,
  on_attach = on_attach,
  settings = {
    yaml = {
      keyOrdering = false,
      schemas = {
        kubernetes = "/*.yaml",
        ["https://json.schemastore.org/github-workflow.json"] = "/.github/workflows/*.yaml",
        ["https://json.schemastore.org/helm-values.json"] = "values*.yaml",
        ["https://json.schemastore.org/github-action.json"] = "action.yaml",
      },
      validate = true,
      completion = true,
      hover = true,
    },
  },
})

-- Terraform
lspconfig.terraformls.setup({
  capabilities = capabilities,
  on_attach = on_attach,
})

-- Bash
lspconfig.bashls.setup({
  capabilities = capabilities,
  on_attach = on_attach,
})

-- Helm
lspconfig.helm_ls.setup({
  capabilities = capabilities,
  on_attach = on_attach,
  settings = {
    ["helm-ls"] = {
      yamlls = {
        path = "yaml-language-server",
      },
    },
  },
})
```

### Autoformat on Save

```lua
-- ~/.config/nvim/lua/formatting.lua
local conform = require("conform")

conform.setup({
  formatters_by_ft = {
    go = { "gofumpt", "goimports" },
    python = { "black", "isort" },
    yaml = { "yamlfmt" },
    terraform = { "terraform_fmt" },
    sh = { "shfmt" },
    bash = { "shfmt" },
    json = { "jq" },
  },
  format_on_save = {
    timeout_ms = 2000,
    lsp_fallback = true,
  },
})
```

## Telescope for Fuzzy Finding

**Telescope** provides a unified fuzzy-finder interface for files, buffers, grep results, Git history, LSP symbols, and more. It is one of the highest-leverage plugins for navigating large infrastructure repositories:

```lua
-- ~/.config/nvim/lua/telescope-config.lua
local telescope = require("telescope")
local builtin = require("telescope.builtin")
local actions = require("telescope.actions")

telescope.setup({
  defaults = {
    mappings = {
      i = {
        ["<C-j>"] = actions.move_selection_next,
        ["<C-k>"] = actions.move_selection_previous,
        ["<C-q>"] = actions.send_to_qflist + actions.open_qflist,
        ["<esc>"] = actions.close,
      },
    },
    file_ignore_patterns = {
      "node_modules",
      ".git/",
      ".terraform/",
      "vendor/",
      "*.tfstate",
      "*.tfstate.backup",
    },
    vimgrep_arguments = {
      "rg", "--color=never", "--no-heading", "--with-filename",
      "--line-number", "--column", "--smart-case", "--hidden",
    },
  },
  extensions = {
    fzf = {
      fuzzy = true,
      override_generic_sorter = true,
      override_file_sorter = true,
      case_mode = "smart_case",
    },
  },
})

telescope.load_extension("fzf")

-- Keymaps for Telescope
local map = vim.keymap.set
local opts = { noremap = true, silent = true }

map("n", "<leader>ff", builtin.find_files,                      opts)
map("n", "<leader>fg", builtin.live_grep,                       opts)
map("n", "<leader>fb", builtin.buffers,                         opts)
map("n", "<leader>fh", builtin.help_tags,                       opts)
map("n", "<leader>fs", builtin.lsp_document_symbols,            opts)
map("n", "<leader>fS", builtin.lsp_workspace_symbols,           opts)
map("n", "<leader>fr", builtin.lsp_references,                  opts)
map("n", "<leader>fd", builtin.diagnostics,                     opts)
map("n", "<leader>gc", builtin.git_commits,                     opts)
map("n", "<leader>gb", builtin.git_branches,                    opts)
map("n", "<leader>gs", builtin.git_status,                      opts)
```

`<leader>fg` (live grep with ripgrep) is the most-used binding for DevOps work: finding which Terraform module defines a specific resource, which Helm chart uses a specific environment variable, or which GitHub Actions workflow calls a specific action.

## TreeSitter Configuration

**TreeSitter** provides accurate, incremental syntax highlighting and text objects based on concrete syntax trees rather than regex patterns. It understands the structure of YAML, HCL, Go, and Bash at the AST level:

```lua
-- ~/.config/nvim/lua/treesitter-config.lua
require("nvim-treesitter.configs").setup({
  ensure_installed = {
    "go", "python", "yaml", "hcl", "bash", "dockerfile",
    "json", "lua", "markdown", "markdown_inline", "regex",
    "sql", "toml", "vim", "vimdoc",
  },
  highlight = {
    enable = true,
    additional_vim_regex_highlighting = false,
  },
  indent = { enable = true },
  incremental_selection = {
    enable = true,
    keymaps = {
      init_selection    = "<C-space>",
      node_incremental  = "<C-space>",
      scope_incremental = "<C-s>",
      node_decremental  = "<M-space>",
    },
  },
  textobjects = {
    select = {
      enable = true,
      lookahead = true,
      keymaps = {
        ["af"] = "@function.outer",
        ["if"] = "@function.inner",
        ["ac"] = "@class.outer",
        ["ic"] = "@class.inner",
        ["ab"] = "@block.outer",
        ["ib"] = "@block.inner",
      },
    },
    move = {
      enable = true,
      set_jumps = true,
      goto_next_start     = { ["]m"] = "@function.outer" },
      goto_previous_start = { ["[m"] = "@function.outer" },
    },
  },
})
```

With TreeSitter text objects, pressing `vif` in a Go function selects the function body. `daf` deletes the entire function including its signature. These structural selections are significantly more reliable than regex-based text objects when editing deeply nested YAML or complex HCL.

## Kubernetes-Specific Workflow

The most impactful workflow improvement for Kubernetes engineers is integrating `kubectl` and `helm` operations into the Neovim environment:

```bash
#!/bin/bash
# Apply a Kubernetes manifest via Neovim pipe
kubectl apply -f - < /tmp/manifest.yaml

# Pipe helm template output to Neovim for review
helm template my-release ./chart --values values.yaml | nvim -R -

# Edit a live secret decoded
kubectl get secret my-secret -n production -o json \
  | jq '.data | map_values(@base64d)' \
  | nvim -
```

These commands are most useful as Neovim terminal commands. The `nvim -R -` flag opens stdin in read-only mode, making it safe to page through large Helm template output without accidentally modifying it.

### Custom Kubernetes Keymaps

```lua
-- ~/.config/nvim/lua/k8s-keymaps.lua
local map = vim.keymap.set
local opts = { noremap = true, silent = true }

-- Apply current file to Kubernetes
map("n", "<leader>ka", function()
  local file = vim.fn.expand("%:p")
  vim.cmd("!" .. "kubectl apply -f " .. file)
end, opts)

-- Dry-run apply current file
map("n", "<leader>kd", function()
  local file = vim.fn.expand("%:p")
  vim.cmd("!" .. "kubectl apply --dry-run=client -f " .. file)
end, opts)

-- Validate YAML with kubeval
map("n", "<leader>kv", function()
  local file = vim.fn.expand("%:p")
  vim.cmd("!" .. "kubeval " .. file)
end, opts)

-- Get pods in namespace from current buffer's namespace annotation
map("n", "<leader>kp", function()
  local ns = vim.fn.system("grep -m1 'namespace:' " .. vim.fn.expand("%:p") .. " | awk '{print $2}'")
  ns = ns:gsub("%s+", "")
  if ns ~= "" then
    vim.cmd("!" .. "kubectl get pods -n " .. ns)
  else
    vim.cmd("!" .. "kubectl get pods --all-namespaces")
  end
end, opts)

-- Open Helm values template in split
map("n", "<leader>ht", function()
  local chart_dir = vim.fn.expand("%:p:h")
  vim.cmd("vsplit | terminal helm template test " .. chart_dir .. " | nvim -R -")
end, opts)
```

## Git Integration

**vim-fugitive** provides a full Git interface inside Neovim. **gitsigns** adds inline blame, hunk staging, and diff previews:

```lua
-- ~/.config/nvim/lua/git.lua
require("gitsigns").setup({
  signs = {
    add          = { text = "+" },
    change       = { text = "~" },
    delete       = { text = "_" },
    topdelete    = { text = "‾" },
    changedelete = { text = "~" },
  },
  on_attach = function(bufnr)
    local gs = package.loaded.gitsigns
    local map = vim.keymap.set
    local opts = { buffer = bufnr }

    -- Hunk navigation
    map("n", "]c", gs.next_hunk,                opts)
    map("n", "[c", gs.prev_hunk,                opts)

    -- Stage/reset hunks
    map("n", "<leader>hs", gs.stage_hunk,       opts)
    map("n", "<leader>hr", gs.reset_hunk,       opts)
    map("v", "<leader>hs", function()
      gs.stage_hunk({ vim.fn.line("."), vim.fn.line("v") })
    end, opts)

    -- Stage/reset buffer
    map("n", "<leader>hS", gs.stage_buffer,     opts)
    map("n", "<leader>hR", gs.reset_buffer,     opts)

    -- Preview hunk diff
    map("n", "<leader>hp", gs.preview_hunk,     opts)

    -- Blame
    map("n", "<leader>hb", function()
      gs.blame_line({ full = true })
    end, opts)
    map("n", "<leader>tb", gs.toggle_current_line_blame, opts)

    -- Diff
    map("n", "<leader>hd", gs.diffthis,         opts)
  end,
})
```

## Terminal Integration and tmux Split Workflows

**toggleterm** provides persistent terminal sessions inside Neovim. Combined with tmux, this creates a layered workflow: tmux manages multiple Neovim instances across different repositories, while toggleterm manages shells within each Neovim session:

```lua
-- ~/.config/nvim/lua/terminal.lua
require("toggleterm").setup({
  size = function(term)
    if term.direction == "horizontal" then
      return 15
    elseif term.direction == "vertical" then
      return vim.o.columns * 0.4
    end
  end,
  open_mapping = [[<c-\>]],
  direction = "horizontal",
  shade_terminals = true,
  shading_factor = 2,
  start_in_insert = true,
  persist_size = true,
  persist_mode = true,
  close_on_exit = true,
  shell = vim.o.shell,
  float_opts = {
    border = "curved",
    winblend = 0,
  },
})

-- Dedicated terminals for specific tools
local Terminal = require("toggleterm.terminal").Terminal

local lazygit = Terminal:new({
  cmd = "lazygit",
  hidden = true,
  direction = "float",
  float_opts = { border = "double" },
})

local k9s = Terminal:new({
  cmd = "k9s",
  hidden = true,
  direction = "float",
  float_opts = {
    border = "double",
    width = math.floor(vim.o.columns * 0.95),
    height = math.floor(vim.o.lines * 0.9),
  },
})

vim.keymap.set("n", "<leader>gg", function() lazygit:toggle() end,
  { noremap = true, silent = true, desc = "Toggle lazygit" })
vim.keymap.set("n", "<leader>k9", function() k9s:toggle() end,
  { noremap = true, silent = true, desc = "Toggle k9s" })
```

The `k9s` terminal binding opens a full-screen k9s session inside Neovim. Switch between editing a deployment manifest and watching its pods roll out without leaving the terminal window. This colocation eliminates the mental overhead of tracking window positions across multiple applications.

### tmux Integration

The following `.tmux.conf` excerpt creates a productive Neovim + terminal split for infrastructure work:

```bash
#!/bin/bash
# Create a devops tmux session with standard splits
tmux new-session -d -s devops -x 220 -y 50

# Window 1: Editor (full height, left 65%)
tmux rename-window -t devops:1 "edit"
tmux split-window -t devops:1 -h -p 35

# Right side: split into top (kubectl/helm) and bottom (logs)
tmux split-window -t devops:1.2 -v -p 50

# Start Neovim in the main pane
tmux send-keys -t devops:1.1 "nvim ." Enter

# Window 2: Monitoring
tmux new-window -t devops -n "monitor"
tmux send-keys -t devops:2 "k9s" Enter

tmux attach-session -t devops
```

## Custom Keymaps for DevOps Tasks

```lua
-- ~/.config/nvim/lua/devops-keymaps.lua
local map = vim.keymap.set
local opts = { noremap = true, silent = true }

-- Quick file operations
map("n", "<leader>w",  "<cmd>w<CR>",            opts)  -- Save
map("n", "<leader>q",  "<cmd>q<CR>",            opts)  -- Quit
map("n", "<leader>wq", "<cmd>wq<CR>",           opts)  -- Save and quit
map("n", "<leader>e",  "<cmd>NvimTreeToggle<CR>", opts) -- File explorer

-- Buffer navigation
map("n", "<leader>bn", "<cmd>bnext<CR>",        opts)
map("n", "<leader>bp", "<cmd>bprevious<CR>",    opts)
map("n", "<leader>bd", "<cmd>bdelete<CR>",      opts)

-- Split navigation (works with tmux-vim-navigator)
map("n", "<C-h>", "<C-w>h", opts)
map("n", "<C-j>", "<C-w>j", opts)
map("n", "<C-k>", "<C-w>k", opts)
map("n", "<C-l>", "<C-w>l", opts)

-- Diagnostic shortcuts
map("n", "<leader>xx", "<cmd>TroubleToggle<CR>",                    opts)
map("n", "<leader>xw", "<cmd>TroubleToggle workspace_diagnostics<CR>", opts)
map("n", "<leader>xd", "<cmd>TroubleToggle document_diagnostics<CR>",  opts)

-- Quick base64 decode for Kubernetes secrets (visual mode)
map("v", "<leader>b64", [[c<C-r>=system('base64 --decode', @")<CR>]], opts)

-- Insert current date (useful for changelog entries)
map("n", "<leader>dt", [[i<C-r>=strftime('%Y-%m-%d')<CR><Esc>]], opts)

-- Toggle spell checking (useful for writing documentation)
map("n", "<leader>ts", "<cmd>setlocal spell!<CR>", opts)

-- Reload configuration
map("n", "<leader>sv", "<cmd>source $MYVIMRC<CR>", opts)
```

## YAML Folding and Manifest Navigation

YAML files with hundreds of lines benefit from folding that respects indentation structure:

```lua
-- In ~/.config/nvim/after/ftplugin/yaml.lua
vim.opt_local.foldmethod = "indent"
vim.opt_local.foldlevel = 2
vim.opt_local.foldcolumn = "1"

-- Open all folds by default when entering a file
vim.api.nvim_create_autocmd("BufReadPost", {
  pattern = "*.yaml,*.yml",
  callback = function()
    vim.cmd("normal! zR")  -- Open all folds
  end,
})

-- Custom fold text: show first line + line count
vim.opt_local.foldtext = "v:lua.yaml_foldtext()"
_G.yaml_foldtext = function()
  local line = vim.fn.getline(vim.v.foldstart)
  local count = vim.v.foldend - vim.v.foldstart + 1
  return line .. "  [" .. count .. " lines]"
end
```

With `foldlevel = 2`, a Kubernetes deployment manifest folds the `spec.template.spec.containers` section, `spec.strategy`, and volume definitions independently. Navigate between top-level YAML keys with `]]` and `[[` using TreeSitter's incremental selection, or jump directly to the `spec` key with `/^spec` since the fold reveals the key without expanding it.

## Debugging and Diagnostics Workflows

Neovim's LSP integration provides inline diagnostics that surface infrastructure configuration errors before they reach a Kubernetes cluster. Several workflows are particularly valuable for infrastructure code:

### Terraform Plan Integration

Review Terraform plan output inside Neovim without leaving the editor:

```bash
#!/bin/bash
# Run terraform plan and open the output in a Neovim buffer for review
terraform plan -out=tfplan 2>&1 | nvim -R -c "setf diff" -

# Or use a quickfix-compatible format for jump-to-error navigation
terraform validate -json \
  | jq -r '.diagnostics[] | .range.filename + ":" + (.range.start.line | tostring) + ":" + .summary' \
  | sort -u
```

In Neovim, populate the quickfix list with Terraform validation errors:

```lua
-- ~/.config/nvim/lua/terraform-workflow.lua
local function terraform_validate()
  local result = vim.fn.system("terraform validate -json 2>&1")
  local ok, data = pcall(vim.json.decode, result)
  if not ok or not data.diagnostics then
    vim.notify("terraform validate: " .. result, vim.log.levels.ERROR)
    return
  end

  local qf_items = {}
  for _, diag in ipairs(data.diagnostics) do
    if diag.range then
      table.insert(qf_items, {
        filename = diag.range.filename,
        lnum     = diag.range.start.line,
        col      = diag.range.start.column,
        text     = diag.summary,
        type     = diag.severity == "error" and "E" or "W",
      })
    end
  end

  vim.fn.setqflist(qf_items)
  if #qf_items > 0 then
    vim.cmd("copen")
    vim.notify(#qf_items .. " Terraform validation issues", vim.log.levels.WARN)
  else
    vim.notify("Terraform validation passed", vim.log.levels.INFO)
  end
end

vim.keymap.set("n", "<leader>tv", terraform_validate,
  { noremap = true, silent = true, desc = "Terraform validate" })
```

With this keymap, `<leader>tv` runs `terraform validate`, parses the JSON output, and populates the quickfix list with errors. Navigate between errors with `]q` and `[q`, jumping directly to the offending file and line.

## Conclusion

A well-configured Neovim environment for DevOps work is not a single configuration file — it is a collection of composable tools that model the actual structure of infrastructure code. LSP servers understand the type system of Go, the schema of Kubernetes manifests, and the resource model of Terraform. Telescope finds the needle in a 10,000-file monorepo in milliseconds. TreeSitter text objects navigate YAML structure without understanding regex.

The return on investment compounds over time. The keymaps for applying Kubernetes manifests, the terminal binding for k9s, the Git hunk staging workflow — these reduce the mechanical overhead of infrastructure changes by minutes per operation, adding up to hours per week for engineers who iterate frequently against production systems. The configuration described here is a starting point: adapt the LSP servers, add language-specific plugins for Helm or Jsonnet, and extend the custom keymaps to match the specific operational patterns of the team's infrastructure stack.
