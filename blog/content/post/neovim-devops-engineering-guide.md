---
title: "Neovim for DevOps Engineers: Terminal-Based Development Environment"
date: 2027-10-04T00:00:00-05:00
draft: false
tags: ["Neovim", "DevOps", "Developer Tools", "Terminal", "Productivity"]
categories:
- Developer Tools
- Productivity
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete Neovim configuration guide for DevOps engineers — lazy.nvim, LSP for Go/Python/YAML, Telescope, nvim-tree, which-key, gitsigns, fugitive, kubernetes.nvim, toggleterm, and YAML/HCL editing workflows."
more_link: "yes"
url: "/neovim-devops-engineering-guide/"
---

DevOps engineers spend most of their time in the terminal — SSH sessions, log analysis, YAML editing, infrastructure code, and Kubernetes manifests. A well-configured Neovim environment eliminates the context-switching overhead of bouncing between a terminal and a GUI editor. This guide builds a complete Neovim configuration optimized for DevOps workflows: lazy.nvim plugin management, LSP for Go/Python/YAML/Terraform, Telescope for fuzzy file finding, integrated git workflows, Kubernetes resource editing, and a productive YAML/HCL editing setup that catches configuration errors before they reach the cluster.

<!--more-->

# Neovim for DevOps Engineers: Terminal-Based Development Environment

## Section 1: Installation and Directory Structure

### Install Neovim

```bash
# Ubuntu/Debian — install from AppImage for latest stable
curl -Lo /tmp/nvim.appimage \
  https://github.com/neovim/neovim/releases/download/v0.10.2/nvim.appimage
chmod +x /tmp/nvim.appimage
/tmp/nvim.appimage --appimage-extract
sudo mv squashfs-root/usr/bin/nvim /usr/local/bin/nvim
nvim --version

# macOS
brew install neovim

# Required dependencies
sudo apt-get install -y \
  git ripgrep fd-find tree-sitter-cli \
  nodejs npm \  # For LSP servers
  python3-pip \
  golang-go

# Install language servers
npm install -g \
  typescript-language-server \
  yaml-language-server \
  dockerfile-language-server-nodejs \
  bash-language-server \
  @ansible/ansible-language-server

pip3 install python-lsp-server pylsp-mypy pylsp-rope
go install golang.org/x/tools/gopls@latest
go install github.com/nametake/golangci-lint-langserver@latest
```

### Configuration Directory Structure

```bash
mkdir -p ~/.config/nvim/{lua/config,lua/plugins,lua/utils}

# Final structure:
# ~/.config/nvim/
# ├── init.lua                    -- Entry point
# ├── lua/
# │   ├── config/
# │   │   ├── options.lua         -- Editor options
# │   │   ├── keymaps.lua         -- Global keymaps
# │   │   └── autocmds.lua        -- Auto commands
# │   └── plugins/
# │       ├── coding.lua          -- Completion, snippets
# │       ├── editor.lua          -- File explorer, fuzzy finder
# │       ├── git.lua             -- Git integration
# │       ├── lsp.lua             -- Language servers
# │       ├── treesitter.lua      -- Syntax highlighting
# │       ├── ui.lua              -- Theme, statusline
# │       ├── kubernetes.lua      -- K8s integration
# │       └── devops.lua          -- Terraform, Ansible, etc.
```

## Section 2: init.lua and lazy.nvim Bootstrap

```lua
-- ~/.config/nvim/init.lua
-- Bootstrap lazy.nvim plugin manager
local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"
if not (vim.uv or vim.loop).fs_stat(lazypath) then
  local lazyrepo = "https://github.com/folke/lazy.nvim.git"
  local out = vim.fn.system({
    "git", "clone", "--filter=blob:none", "--branch=stable",
    lazyrepo, lazypath
  })
  if vim.v.shell_error ~= 0 then
    vim.api.nvim_echo({
      { "Failed to clone lazy.nvim:\n", "ErrorMsg" },
      { out, "WarningMsg" },
    }, true, {})
    os.exit(1)
  end
end
vim.opt.rtp:prepend(lazypath)

-- Load core configuration before plugins
require("config.options")
require("config.keymaps")
require("config.autocmds")

-- Initialize lazy.nvim with all plugin specs
require("lazy").setup({
  spec = {
    { import = "plugins" },
  },
  defaults = {
    lazy = true,      -- Load plugins on demand
    version = false,  -- Always use latest commit
  },
  install = {
    colorscheme = { "catppuccin", "habamax" },
  },
  checker = {
    enabled = true,   -- Auto-check for plugin updates
    notify = false,
    frequency = 86400,  -- Check daily
  },
  performance = {
    rtp = {
      disabled_plugins = {
        "gzip", "tarPlugin", "tohtml", "tutor", "zipPlugin",
        "netrwPlugin",  -- Replaced by nvim-tree
      },
    },
  },
  ui = {
    border = "rounded",
  },
})
```

## Section 3: Core Editor Options

```lua
-- ~/.config/nvim/lua/config/options.lua
local opt = vim.opt

-- Editor behavior
opt.number = true
opt.relativenumber = true
opt.cursorline = true
opt.wrap = false
opt.scrolloff = 8
opt.sidescrolloff = 8
opt.signcolumn = "yes"
opt.colorcolumn = "120"

-- Indentation (most DevOps files use 2 spaces)
opt.tabstop = 2
opt.shiftwidth = 2
opt.expandtab = true
opt.smartindent = true
opt.autoindent = true

-- Search
opt.ignorecase = true
opt.smartcase = true
opt.hlsearch = true
opt.incsearch = true

-- Files
opt.fileencoding = "utf-8"
opt.swapfile = false
opt.backup = false
opt.undofile = true
opt.undodir = vim.fn.stdpath("data") .. "/undodir"
opt.autoread = true  -- Auto-reload files changed outside nvim

-- UI
opt.termguicolors = true
opt.splitright = true
opt.splitbelow = true
opt.showmode = false  -- Handled by statusline
opt.conceallevel = 0
opt.pumheight = 10    -- Completion menu height
opt.laststatus = 3    -- Global statusline (nvim 0.7+)

-- Performance
opt.updatetime = 300
opt.timeoutlen = 400
opt.ttimeoutlen = 5

-- YAML specific
vim.api.nvim_create_autocmd("FileType", {
  pattern = { "yaml", "yml" },
  callback = function()
    opt.tabstop = 2
    opt.shiftwidth = 2
    opt.expandtab = true
    -- Show indent guides for YAML
    vim.cmd("IBLEnable")
  end,
})

-- HCL/Terraform
vim.api.nvim_create_autocmd("FileType", {
  pattern = { "terraform", "hcl" },
  callback = function()
    opt.tabstop = 2
    opt.shiftwidth = 2
  end,
})
```

## Section 4: LSP Configuration

```lua
-- ~/.config/nvim/lua/plugins/lsp.lua
return {
  -- Mason: manages LSP servers, linters, formatters
  {
    "williamboman/mason.nvim",
    cmd = "Mason",
    keys = { { "<leader>cm", "<cmd>Mason<cr>", desc = "Mason" } },
    build = ":MasonUpdate",
    opts = {
      ensure_installed = {
        -- LSP servers
        "gopls",              -- Go
        "pyright",            -- Python
        "yaml-language-server",
        "terraform-ls",
        "tflint",
        "dockerfile-language-server",
        "bash-language-server",
        "ansible-language-server",
        "helm-ls",
        "lua-language-server",
        -- Formatters
        "prettier",           -- YAML, JSON
        "gofumpt",
        "black",              -- Python
        "shfmt",              -- Shell
        "terraform-fmt",
        -- Linters
        "golangci-lint",
        "ruff",               -- Python
        "hadolint",           -- Dockerfile
        "yamllint",
        "shellcheck",
        "tfsec",
      },
    },
  },

  -- nvim-lspconfig
  {
    "neovim/nvim-lspconfig",
    dependencies = {
      "williamboman/mason.nvim",
      "williamboman/mason-lspconfig.nvim",
      "hrsh7th/cmp-nvim-lsp",
      { "j-hui/fidget.nvim", opts = {} },  -- LSP progress indicator
    },
    event = { "BufReadPre", "BufNewFile" },
    config = function()
      local lspconfig = require("lspconfig")
      local capabilities = require("cmp_nvim_lsp").default_capabilities()

      -- Keymaps applied when LSP attaches
      vim.api.nvim_create_autocmd("LspAttach", {
        group = vim.api.nvim_create_augroup("UserLspConfig", {}),
        callback = function(ev)
          local opts = { buffer = ev.buf }
          local map = vim.keymap.set

          map("n", "gd", vim.lsp.buf.definition, vim.tbl_extend("force", opts, { desc = "Go to Definition" }))
          map("n", "gD", vim.lsp.buf.declaration, vim.tbl_extend("force", opts, { desc = "Go to Declaration" }))
          map("n", "gi", vim.lsp.buf.implementation, vim.tbl_extend("force", opts, { desc = "Go to Implementation" }))
          map("n", "gr", require("telescope.builtin").lsp_references, vim.tbl_extend("force", opts, { desc = "References" }))
          map("n", "K", vim.lsp.buf.hover, vim.tbl_extend("force", opts, { desc = "Hover Documentation" }))
          map("n", "<leader>ca", vim.lsp.buf.code_action, vim.tbl_extend("force", opts, { desc = "Code Action" }))
          map("n", "<leader>rn", vim.lsp.buf.rename, vim.tbl_extend("force", opts, { desc = "Rename Symbol" }))
          map("n", "<leader>cf", vim.lsp.buf.format, vim.tbl_extend("force", opts, { desc = "Format Buffer" }))
          map("n", "[d", vim.diagnostic.goto_prev, vim.tbl_extend("force", opts, { desc = "Previous Diagnostic" }))
          map("n", "]d", vim.diagnostic.goto_next, vim.tbl_extend("force", opts, { desc = "Next Diagnostic" }))
          map("n", "<leader>cd", vim.diagnostic.open_float, vim.tbl_extend("force", opts, { desc = "Open Diagnostic Float" }))
        end,
      })

      -- Go LSP
      lspconfig.gopls.setup({
        capabilities = capabilities,
        settings = {
          gopls = {
            analyses = {
              unusedparams = true,
              shadow = true,
              unusedwrite = true,
              useany = true,
            },
            staticcheck = true,
            gofumpt = true,
            hints = {
              assignVariableTypes = true,
              compositeLiteralFields = true,
              constantValues = true,
              functionTypeParameters = true,
              parameterNames = true,
              rangeVariableTypes = true,
            },
          },
        },
      })

      -- Python LSP
      lspconfig.pyright.setup({
        capabilities = capabilities,
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

      -- YAML LSP with Kubernetes schema support
      lspconfig.yamlls.setup({
        capabilities = capabilities,
        settings = {
          yaml = {
            format = { enable = true },
            hover = true,
            completion = true,
            validate = true,
            schemas = {
              -- Auto-detect Kubernetes manifests
              kubernetes = "/*.yaml",
              -- Specific schemas
              ["https://json.schemastore.org/github-workflow.json"] = "/.github/workflows/*.{yml,yaml}",
              ["https://json.schemastore.org/helm-chart.json"] = "Chart.{yml,yaml}",
              ["https://raw.githubusercontent.com/instrumenta/kubernetes-json-schema/master/v1.30.0-standalone-strict/all.json"] = {
                "/**/templates/*.yaml",
                "/**/manifests/*.yaml",
              },
              ["https://json.schemastore.org/kustomization.json"] = "kustomization.{yml,yaml}",
              ["https://json.schemastore.org/helmfile.json"] = "helmfile.{yml,yaml}",
            },
            schemaStore = {
              enable = true,
              url = "https://www.schemastore.org/api/json/catalog.json",
            },
          },
        },
      })

      -- Terraform LSP
      lspconfig.terraformls.setup({ capabilities = capabilities })

      -- Dockerfile LSP
      lspconfig.dockerls.setup({ capabilities = capabilities })

      -- Bash LSP
      lspconfig.bashls.setup({
        capabilities = capabilities,
        filetypes = { "sh", "bash", "zsh" },
      })

      -- Helm LSP
      lspconfig.helm_ls.setup({
        capabilities = capabilities,
        settings = {
          ["helm-ls"] = {
            yamlls = {
              path = "yaml-language-server",
            },
          },
        },
      })

      -- Lua LSP (for neovim config itself)
      lspconfig.lua_ls.setup({
        capabilities = capabilities,
        settings = {
          Lua = {
            runtime = { version = "LuaJIT" },
            workspace = {
              checkThirdParty = false,
              library = vim.api.nvim_get_runtime_file("", true),
            },
            diagnostics = { globals = { "vim" } },
            format = { enable = false },
          },
        },
      })
    end,
  },
}
```

## Section 5: Telescope Fuzzy Finder

```lua
-- ~/.config/nvim/lua/plugins/editor.lua
return {
  -- Telescope
  {
    "nvim-telescope/telescope.nvim",
    tag = "0.1.8",
    dependencies = {
      "nvim-lua/plenary.nvim",
      {
        "nvim-telescope/telescope-fzf-native.nvim",
        build = "make",
        cond = function() return vim.fn.executable("make") == 1 end,
      },
      "nvim-telescope/telescope-ui-select.nvim",
      "nvim-tree/nvim-web-devicons",
    },
    cmd = "Telescope",
    keys = {
      -- File finding
      { "<leader>ff", "<cmd>Telescope find_files<cr>",                   desc = "Find Files" },
      { "<leader>fg", "<cmd>Telescope live_grep<cr>",                    desc = "Grep (live)" },
      { "<leader>fb", "<cmd>Telescope buffers<cr>",                      desc = "Buffers" },
      { "<leader>fr", "<cmd>Telescope oldfiles<cr>",                     desc = "Recent Files" },
      { "<leader>fh", "<cmd>Telescope help_tags<cr>",                    desc = "Help Tags" },
      -- Git
      { "<leader>gc", "<cmd>Telescope git_commits<cr>",                  desc = "Git Commits" },
      { "<leader>gb", "<cmd>Telescope git_branches<cr>",                 desc = "Git Branches" },
      { "<leader>gs", "<cmd>Telescope git_status<cr>",                   desc = "Git Status" },
      -- LSP
      { "<leader>fs", "<cmd>Telescope lsp_document_symbols<cr>",        desc = "Document Symbols" },
      { "<leader>fS", "<cmd>Telescope lsp_workspace_symbols<cr>",       desc = "Workspace Symbols" },
      { "<leader>fd", "<cmd>Telescope diagnostics<cr>",                 desc = "Diagnostics" },
      -- Kubernetes/DevOps specific
      { "<leader>fk", "<cmd>Telescope find_files cwd=~/.kube<cr>",      desc = "Kubeconfig Files" },
      { "<leader>ft", "<cmd>Telescope find_files cwd=./terraform<cr>",  desc = "Terraform Files" },
    },
    config = function()
      local telescope = require("telescope")
      local actions = require("telescope.actions")

      telescope.setup({
        defaults = {
          prompt_prefix = " ",
          selection_caret = " ",
          path_display = { "smart" },
          file_ignore_patterns = {
            "%.git/", "node_modules/", "%.terraform/",
            "vendor/", "%.cache/", "dist/", "build/",
          },
          mappings = {
            i = {
              ["<C-j>"] = actions.move_selection_next,
              ["<C-k>"] = actions.move_selection_previous,
              ["<C-q>"] = actions.send_selected_to_qflist + actions.open_qflist,
              ["<esc>"] = actions.close,
            },
          },
          layout_strategy = "horizontal",
          layout_config = {
            horizontal = {
              preview_width = 0.55,
              results_width = 0.8,
            },
            width = 0.87,
            height = 0.80,
            preview_cutoff = 120,
          },
        },
        extensions = {
          fzf = {
            fuzzy = true,
            override_generic_sorter = true,
            override_file_sorter = true,
            case_mode = "smart_case",
          },
          ["ui-select"] = {
            require("telescope.themes").get_dropdown(),
          },
        },
      })

      telescope.load_extension("fzf")
      telescope.load_extension("ui-select")
    end,
  },

  -- nvim-tree file explorer
  {
    "nvim-tree/nvim-tree.lua",
    version = "*",
    dependencies = { "nvim-tree/nvim-web-devicons" },
    cmd = { "NvimTreeToggle", "NvimTreeFocus" },
    keys = {
      { "<leader>e", "<cmd>NvimTreeToggle<cr>",   desc = "File Explorer" },
      { "<leader>E", "<cmd>NvimTreeFocus<cr>",    desc = "Focus Explorer" },
    },
    opts = {
      sort = { sorter = "case_sensitive" },
      view = {
        width = 35,
        side = "left",
      },
      renderer = {
        group_empty = true,
        icons = {
          glyphs = {
            git = {
              unstaged = "✗",
              staged = "✓",
              unmerged = "",
              renamed = "➜",
              untracked = "★",
              deleted = "",
            },
          },
        },
      },
      filters = {
        dotfiles = false,
        custom = { "^.git$", "node_modules", "^.cache$" },
      },
      git = { enable = true, ignore = false },
      actions = {
        open_file = {
          quit_on_open = false,
          window_picker = { enable = false },
        },
      },
      on_attach = function(bufnr)
        local api = require("nvim-tree.api")
        local opts = { buffer = bufnr, noremap = true, silent = true, nowait = true }

        api.config.mappings.default_on_attach(bufnr)
        vim.keymap.set("n", "l", api.node.open.edit, opts)
        vim.keymap.set("n", "h", api.node.navigate.parent_close, opts)
        vim.keymap.set("n", "H", api.tree.collapse_all, opts)
      end,
    },
  },
}
```

## Section 6: Git Integration

```lua
-- ~/.config/nvim/lua/plugins/git.lua
return {
  -- gitsigns: inline git blame, hunk navigation, staging
  {
    "lewis6991/gitsigns.nvim",
    event = { "BufReadPre", "BufNewFile" },
    opts = {
      signs = {
        add          = { text = "▎" },
        change       = { text = "▎" },
        delete       = { text = "" },
        topdelete    = { text = "" },
        changedelete = { text = "▎" },
        untracked    = { text = "▎" },
      },
      current_line_blame = true,
      current_line_blame_opts = {
        virt_text = true,
        virt_text_pos = "eol",
        delay = 500,
      },
      current_line_blame_formatter = "<author>, <author_time:%Y-%m-%d> - <summary>",
      on_attach = function(bufnr)
        local gs = require("gitsigns")
        local map = vim.keymap.set
        local opts = { buffer = bufnr }

        -- Navigation
        map("n", "]h", gs.next_hunk, vim.tbl_extend("force", opts, { desc = "Next Hunk" }))
        map("n", "[h", gs.prev_hunk, vim.tbl_extend("force", opts, { desc = "Prev Hunk" }))

        -- Actions
        map({ "n", "v" }, "<leader>ghs", ":Gitsigns stage_hunk<cr>", vim.tbl_extend("force", opts, { desc = "Stage Hunk" }))
        map({ "n", "v" }, "<leader>ghr", ":Gitsigns reset_hunk<cr>", vim.tbl_extend("force", opts, { desc = "Reset Hunk" }))
        map("n", "<leader>ghS", gs.stage_buffer, vim.tbl_extend("force", opts, { desc = "Stage Buffer" }))
        map("n", "<leader>ghu", gs.undo_stage_hunk, vim.tbl_extend("force", opts, { desc = "Undo Stage Hunk" }))
        map("n", "<leader>ghp", gs.preview_hunk, vim.tbl_extend("force", opts, { desc = "Preview Hunk" }))
        map("n", "<leader>ghb", function() gs.blame_line({ full = true }) end, vim.tbl_extend("force", opts, { desc = "Blame Line" }))
        map("n", "<leader>ghd", gs.diffthis, vim.tbl_extend("force", opts, { desc = "Diff This" }))
        map("n", "<leader>ghD", function() gs.diffthis("~") end, vim.tbl_extend("force", opts, { desc = "Diff This ~" }))

        -- Text objects
        map({ "o", "x" }, "ih", ":<C-U>Gitsigns select_hunk<CR>", vim.tbl_extend("force", opts, { desc = "Select Hunk" }))
      end,
    },
  },

  -- vim-fugitive: full git interface
  {
    "tpope/vim-fugitive",
    cmd = { "G", "Git", "Gdiffsplit", "Gread", "Gwrite", "Ggrep", "GMove", "GDelete", "GBrowse" },
    keys = {
      { "<leader>gg", "<cmd>Git<cr>",           desc = "Git Status (Fugitive)" },
      { "<leader>gG", "<cmd>Git log --oneline<cr>", desc = "Git Log" },
      { "<leader>gd", "<cmd>Gdiffsplit<cr>",    desc = "Git Diff Split" },
      { "<leader>gp", "<cmd>Git push<cr>",      desc = "Git Push" },
      { "<leader>gl", "<cmd>Git pull<cr>",      desc = "Git Pull" },
      { "<leader>gB", "<cmd>GBrowse<cr>",       desc = "Browse on GitHub" },
    },
  },

  -- diffview: better diff view
  {
    "sindrets/diffview.nvim",
    cmd = { "DiffviewOpen", "DiffviewClose", "DiffviewFileHistory" },
    keys = {
      { "<leader>gv", "<cmd>DiffviewOpen<cr>",              desc = "DiffView Open" },
      { "<leader>gV", "<cmd>DiffviewClose<cr>",             desc = "DiffView Close" },
      { "<leader>gh", "<cmd>DiffviewFileHistory %<cr>",     desc = "File History" },
    },
  },
}
```

## Section 7: which-key for Keybinding Discovery

```lua
-- ~/.config/nvim/lua/plugins/ui.lua (partial)
return {
  {
    "folke/which-key.nvim",
    event = "VeryLazy",
    init = function()
      vim.o.timeout = true
      vim.o.timeoutlen = 300
    end,
    opts = {
      preset = "modern",
      delay = 300,
      icons = {
        breadcrumb = "»",
        separator = "➜",
        group = "+",
      },
      win = {
        border = "rounded",
        padding = { 1, 2 },
        wo = { winblend = 10 },
      },
      layout = { align = "left" },
      spec = {
        -- Leader key groups
        { "<leader>f",   group = "Find" },
        { "<leader>g",   group = "Git" },
        { "<leader>gh",  group = "Hunks" },
        { "<leader>c",   group = "Code" },
        { "<leader>k",   group = "Kubernetes" },
        { "<leader>t",   group = "Terminal" },
        { "<leader>b",   group = "Buffer" },
        { "<leader>x",   group = "Trouble/Diagnostics" },
        { "<leader>s",   group = "Search/Replace" },
        { "<leader>n",   group = "Notes/Todo" },
        -- Buffer navigation
        { "<S-h>", "<cmd>BufferLineCyclePrev<cr>",  desc = "Previous Buffer" },
        { "<S-l>", "<cmd>BufferLineCycleNext<cr>",  desc = "Next Buffer" },
      },
    },
  },
}
```

## Section 8: Kubernetes Plugin Integration

```lua
-- ~/.config/nvim/lua/plugins/kubernetes.lua
return {
  -- kubectl.nvim — interact with K8s from nvim
  {
    "ramilito/kubectl.nvim",
    cmd = "Kubectl",
    keys = {
      { "<leader>kk", "<cmd>lua require('kubectl').toggle()<cr>", desc = "Kubectl Toggle" },
    },
    opts = {
      auto_refresh = {
        enabled = true,
        interval = 300,  -- Refresh every 5 minutes
      },
      diff = {
        live_reload = true,
      },
      kubectl_cmd = { cmd = "kubectl", env = {}, args = {} },
    },
  },

  -- Helm file detection and syntax
  {
    "towolf/vim-helm",
    ft = { "helm" },
  },

  -- YAML schema validation (augments yamlls)
  {
    "someone-stole-my-name/yaml-companion.nvim",
    ft = { "yaml", "yml" },
    dependencies = {
      "neovim/nvim-lspconfig",
      "nvim-lua/plenary.nvim",
      "nvim-telescope/telescope.nvim",
    },
    config = function()
      local cfg = require("yaml-companion").setup({
        builtin_matchers = {
          kubernetes = { enabled = true },
          cloud_init = { enabled = true },
        },
        schemas = {
          {
            name = "Kubernetes 1.30",
            uri = "https://raw.githubusercontent.com/instrumenta/kubernetes-json-schema/master/v1.30.0-standalone-strict/all.json",
          },
          {
            name = "GitHub Actions",
            uri = "https://json.schemastore.org/github-workflow.json",
          },
          {
            name = "Helm Chart Values",
            uri = "https://raw.githubusercontent.com/SchemaStore/schemastore/master/src/schemas/json/helmfile.json",
          },
          {
            name = "ArgoCD Application",
            uri = "https://raw.githubusercontent.com/argoproj/argo-cd/master/docs/operator-manual/application-crd.json",
          },
          {
            name = "Kustomization",
            uri = "https://json.schemastore.org/kustomization.json",
          },
        },
        lspconfig = {
          flags = { debounce_text_changes = 150 },
          settings = {
            redhat = { telemetry = { enabled = false } },
          },
        },
      })

      require("lspconfig").yamlls.setup(cfg)
      require("telescope").load_extension("yaml_schema")
    end,
  },
}
```

### Kubernetes Workflow Keymaps

```lua
-- ~/.config/nvim/lua/config/keymaps.lua
local map = vim.keymap.set

-- Kubernetes operations via terminal integration
map("n", "<leader>ka", function()
  require("toggleterm.terminal").Terminal:new({
    cmd = "kubectl apply -f " .. vim.fn.expand("%"),
    direction = "float",
    close_on_exit = false,
  }):toggle()
end, { desc = "kubectl apply current file" })

map("n", "<leader>kd", function()
  require("toggleterm.terminal").Terminal:new({
    cmd = "kubectl delete -f " .. vim.fn.expand("%"),
    direction = "float",
    close_on_exit = false,
  }):toggle()
end, { desc = "kubectl delete current file" })

map("n", "<leader>kD", function()
  require("toggleterm.terminal").Terminal:new({
    cmd = "kubectl diff -f " .. vim.fn.expand("%"),
    direction = "float",
    close_on_exit = false,
  }):toggle()
end, { desc = "kubectl diff current file" })

map("n", "<leader>kl", function()
  require("toggleterm.terminal").Terminal:new({
    cmd = "kubectl logs -f " .. vim.fn.input("pod name: "),
    direction = "float",
    close_on_exit = false,
  }):toggle()
end, { desc = "kubectl logs pod" })

-- Terraform operations
map("n", "<leader>ti", function()
  require("toggleterm.terminal").Terminal:new({
    cmd = "cd " .. vim.fn.expand("%:p:h") .. " && terraform init",
    direction = "float",
    close_on_exit = false,
  }):toggle()
end, { desc = "terraform init" })

map("n", "<leader>tp", function()
  require("toggleterm.terminal").Terminal:new({
    cmd = "cd " .. vim.fn.expand("%:p:h") .. " && terraform plan",
    direction = "float",
    close_on_exit = false,
  }):toggle()
end, { desc = "terraform plan" })

map("n", "<leader>tv", function()
  require("toggleterm.terminal").Terminal:new({
    cmd = "cd " .. vim.fn.expand("%:p:h") .. " && terraform validate",
    direction = "float",
    close_on_exit = false,
  }):toggle()
end, { desc = "terraform validate" })
```

## Section 9: Toggleterm Integrated Terminal

```lua
-- ~/.config/nvim/lua/plugins/devops.lua (partial)
return {
  {
    "akinsho/toggleterm.nvim",
    version = "*",
    keys = {
      { "<C-`>", desc = "Toggle terminal" },
      { "<leader>tf", desc = "Float terminal" },
      { "<leader>th", desc = "Horizontal terminal" },
      { "<leader>tv", desc = "Vertical terminal" },
      { "<leader>tg", desc = "LazyGit" },
      { "<leader>tk", desc = "K9s" },
      { "<leader>tz", desc = "Zellij/tmux" },
    },
    opts = {
      size = function(term)
        if term.direction == "horizontal" then
          return 15
        elseif term.direction == "vertical" then
          return vim.o.columns * 0.4
        end
      end,
      open_mapping = [[<C-`>]],
      direction = "float",
      float_opts = {
        border = "curved",
        width = math.floor(vim.o.columns * 0.85),
        height = math.floor(vim.o.lines * 0.85),
        winblend = 3,
      },
      shade_terminals = false,
      auto_scroll = true,
    },
    config = function(_, opts)
      require("toggleterm").setup(opts)

      local Terminal = require("toggleterm.terminal").Terminal
      local map = vim.keymap.set

      -- LazyGit
      local lazygit = Terminal:new({
        cmd = "lazygit",
        dir = "git_dir",
        direction = "float",
        float_opts = { border = "double" },
        on_open = function(term)
          vim.cmd("startinsert!")
          vim.api.nvim_buf_set_keymap(term.bufnr, "n", "q", "<cmd>close<CR>", { noremap = true, silent = true })
        end,
      })
      map("n", "<leader>tg", function() lazygit:toggle() end, { desc = "LazyGit" })

      -- K9s
      local k9s = Terminal:new({
        cmd = "k9s",
        direction = "float",
        float_opts = { width = math.floor(vim.o.columns * 0.95), height = math.floor(vim.o.lines * 0.95) },
      })
      map("n", "<leader>tk", function() k9s:toggle() end, { desc = "K9s" })

      -- Dedicated terminals
      local horizontal_term = Terminal:new({ direction = "horizontal" })
      local vertical_term = Terminal:new({ direction = "vertical" })
      local float_term = Terminal:new({ direction = "float" })

      map("n", "<leader>th", function() horizontal_term:toggle() end, { desc = "Horizontal Terminal" })
      map("n", "<leader>tv", function() vertical_term:toggle() end, { desc = "Vertical Terminal" })
      map("n", "<leader>tf", function() float_term:toggle() end, { desc = "Float Terminal" })

      -- Terminal mode escape
      vim.keymap.set("t", "<esc><esc>", "<c-\\><c-n>", { desc = "Enter Normal Mode" })
      vim.keymap.set("t", "<C-h>", "<cmd>wincmd h<cr>", { desc = "Move to left window" })
      vim.keymap.set("t", "<C-j>", "<cmd>wincmd j<cr>", { desc = "Move to lower window" })
      vim.keymap.set("t", "<C-k>", "<cmd>wincmd k<cr>", { desc = "Move to upper window" })
      vim.keymap.set("t", "<C-l>", "<cmd>wincmd l<cr>", { desc = "Move to right window" })
    end,
  },
}
```

## Section 10: YAML and HCL Editing Workflow

### Auto-commands for DevOps Files

```lua
-- ~/.config/nvim/lua/config/autocmds.lua
local function augroup(name)
  return vim.api.nvim_create_augroup("devops_" .. name, { clear = true })
end

-- YAML: validate on save with yamllint
vim.api.nvim_create_autocmd("BufWritePost", {
  group = augroup("yaml_lint"),
  pattern = { "*.yaml", "*.yml" },
  callback = function()
    local file = vim.fn.expand("%:p")
    local result = vim.fn.system("yamllint -d relaxed " .. file .. " 2>&1")
    if vim.v.shell_error ~= 0 then
      vim.notify("yamllint: " .. result, vim.log.levels.WARN, { title = "YAML Lint" })
    end
  end,
})

-- Terraform: format on save
vim.api.nvim_create_autocmd("BufWritePre", {
  group = augroup("terraform_fmt"),
  pattern = { "*.tf", "*.tfvars" },
  callback = function()
    vim.lsp.buf.format({ async = false })
  end,
})

-- Kubernetes YAML: detect schema and show namespace context
vim.api.nvim_create_autocmd("BufEnter", {
  group = augroup("k8s_context"),
  pattern = { "*.yaml", "*.yml" },
  callback = function()
    local content = vim.api.nvim_buf_get_lines(0, 0, 5, false)
    local is_k8s = false
    for _, line in ipairs(content) do
      if line:match("apiVersion:") or line:match("kind:") then
        is_k8s = true
        break
      end
    end
    if is_k8s then
      local ctx = vim.fn.system("kubectl config current-context 2>/dev/null"):gsub("\n", "")
      local ns = vim.fn.system("kubectl config view --minify --output 'jsonpath={..namespace}' 2>/dev/null"):gsub("\n", "")
      vim.notify(string.format("K8s: %s / %s", ctx, ns ~= "" and ns or "default"),
        vim.log.levels.INFO, { title = "Kubernetes Context", timeout = 2000 })
    end
  end,
})

-- Go: organize imports on save
vim.api.nvim_create_autocmd("BufWritePre", {
  group = augroup("go_imports"),
  pattern = "*.go",
  callback = function()
    local params = vim.lsp.util.make_range_params()
    params.context = { only = { "source.organizeImports" } }
    local result = vim.lsp.buf_request_sync(0, "textDocument/codeAction", params, 3000)
    for cid, res in pairs(result or {}) do
      for _, r in pairs(res.result or {}) do
        if r.edit then
          local enc = (vim.lsp.get_client_by_id(cid) or {}).offset_encoding or "utf-16"
          vim.lsp.util.apply_workspace_edit(r.edit, enc)
        end
      end
    end
    vim.lsp.buf.format({ async = false })
  end,
})
```

### Quick K8s Snippet Setup

```lua
-- ~/.config/nvim/lua/plugins/coding.lua (snippets section)
-- LuaSnip snippet for common K8s patterns
local ls = require("luasnip")
local s = ls.snippet
local t = ls.text_node
local i = ls.insert_node

ls.add_snippets("yaml", {
  -- Deployment snippet
  s("deploy", {
    t({ "apiVersion: apps/v1", "kind: Deployment", "metadata:", "  name: " }), i(1, "app-name"),
    t({ "", "  namespace: " }), i(2, "default"),
    t({ "", "  labels:", "    app: " }), i(3, "app-name"),
    t({ "", "spec:", "  replicas: " }), i(4, "2"),
    t({ "", "  selector:", "    matchLabels:", "      app: " }), i(5, "app-name"),
    t({ "", "  template:", "    metadata:", "      labels:", "        app: " }), i(6, "app-name"),
    t({ "", "    spec:", "      containers:", "        - name: " }), i(7, "app-name"),
    t({ "", "          image: " }), i(8, "nginx:1.25"),
    t({ "", "          ports:", "            - containerPort: " }), i(9, "8080"),
    t({ "", "          resources:", "            requests:", "              cpu: " }), i(10, "100m"),
    t({ "", "              memory: " }), i(11, "128Mi"),
    t({ "", "            limits:", "              cpu: " }), i(12, "500m"),
    t({ "", "              memory: " }), i(13, "512Mi"),
  }),
})
```

## Summary

A well-configured Neovim environment for DevOps engineering provides native LSP intelligence for every file type encountered daily — Go services, Python scripts, YAML manifests, Terraform modules, Dockerfiles, and shell scripts. The combination of Telescope for instant fuzzy search, nvim-tree for project navigation, gitsigns+fugitive for seamless git workflow, and toggleterm for embedded terminal access eliminates most reasons to leave the editor.

The YAML LSP schema detection automatically selects Kubernetes, Helm, GitHub Actions, and ArgoCD schemas, providing inline validation that catches structure errors before `kubectl apply`. The auto-commands validate files on save and format on write, maintaining code quality as a background concern rather than a deliberate step.
