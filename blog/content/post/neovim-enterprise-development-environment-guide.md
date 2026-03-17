---
title: "Neovim as an Enterprise Development Environment: LSP, DAP, and Productivity Plugins"
date: 2028-09-14T00:00:00-05:00
draft: false
tags: ["Neovim", "Developer Tools", "LSP", "Productivity", "Linux"]
categories:
- Neovim
- Developer Tools
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete Neovim setup guide — lazy.nvim plugin manager, LSP configuration for Go/Python/TypeScript, nvim-dap debugger, Telescope fuzzy finding, git integration, treesitter, and terminal integration for daily engineering work."
more_link: "yes"
url: "/neovim-enterprise-development-environment-guide/"
---

The argument for Neovim as a primary development environment is not about nostalgia for modal editing or aesthetic preference for terminal UIs. It is about speed, composability, and the ability to run a full IDE-quality environment over SSH on remote servers, in containers, and on machines with constrained resources. A properly configured Neovim with LSP, DAP, Telescope, and treesitter rivals VS Code on every capability that matters to a DevOps engineer: code navigation, debugging, git operations, and fuzzy search across large codebases. This guide builds that configuration from first principles using lazy.nvim, targeting Go, Python, and TypeScript — the three languages most DevOps engineers encounter daily.

<!--more-->

# Neovim as an Enterprise Development Environment: LSP, DAP, and Productivity Plugins

## Prerequisites

- Neovim 0.10+ (build from source or use a PPA for the latest stable)
- Git 2.36+
- Node.js 18+ (required by several language servers)
- Go 1.22+ (for gopls)
- Python 3.11+ with pip
- A Nerd Font installed in your terminal emulator (enables icons)
- `ripgrep` and `fd` for Telescope file searching

```bash
# Ubuntu/Debian — install Neovim 0.10 from PPA
sudo add-apt-repository ppa:neovim-ppa/unstable -y
sudo apt update
sudo apt install -y neovim

# Required system dependencies
sudo apt install -y ripgrep fd-find tree-sitter-cli unzip curl

# Verify
nvim --version | head -1
# NVIM v0.10.0
```

## Section 1: Directory Structure

Organize your configuration following the XDG standard that Neovim expects:

```
~/.config/nvim/
├── init.lua                    # Entry point — loads lazy.nvim and plugin specs
├── lua/
│   ├── config/
│   │   ├── options.lua         # vim.opt settings
│   │   ├── keymaps.lua         # Global keybindings (non-plugin)
│   │   └── autocmds.lua        # Autocommands
│   └── plugins/
│       ├── lsp.lua             # LSP configuration
│       ├── dap.lua             # Debugger configuration
│       ├── telescope.lua       # Fuzzy finder
│       ├── treesitter.lua      # Syntax and structural editing
│       ├── completion.lua      # nvim-cmp autocompletion
│       ├── git.lua             # Fugitive, gitsigns, diffview
│       ├── editor.lua          # Editing quality-of-life plugins
│       ├── ui.lua              # Statusline, bufferline, colorscheme
│       └── terminal.lua        # Terminal and tmux integration
```

## Section 2: Bootstrap — init.lua and lazy.nvim

```lua
-- ~/.config/nvim/init.lua
-- Bootstrap lazy.nvim package manager
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

-- Set leader keys before loading plugins
vim.g.mapleader = " "
vim.g.maplocalleader = "\\"

-- Load configuration modules
require("config.options")
require("config.keymaps")
require("config.autocmds")

-- Load plugins via lazy.nvim
require("lazy").setup("plugins", {
  defaults = {
    lazy = true,  -- Lazy-load by default for faster startup
  },
  performance = {
    rtp = {
      disabled_plugins = {
        "gzip", "matchit", "matchparen", "netrwPlugin",
        "tarPlugin", "tohtml", "tutor", "zipPlugin",
      },
    },
  },
  checker = {
    enabled = true,
    notify = false,  -- Don't spam on startup
  },
})
```

```lua
-- ~/.config/nvim/lua/config/options.lua
local opt = vim.opt

-- Line numbers
opt.number = true
opt.relativenumber = true

-- Indentation
opt.expandtab = true
opt.shiftwidth = 2
opt.tabstop = 2
opt.smartindent = true

-- Searching
opt.ignorecase = true
opt.smartcase = true
opt.hlsearch = false
opt.incsearch = true

-- UI
opt.termguicolors = true
opt.signcolumn = "yes"
opt.cursorline = true
opt.scrolloff = 8
opt.sidescrolloff = 8
opt.wrap = false
opt.splitright = true
opt.splitbelow = true
opt.showmode = false  -- Status line shows mode

-- Performance
opt.updatetime = 100
opt.timeoutlen = 300

-- Files
opt.swapfile = false
opt.backup = false
opt.undofile = true
opt.undodir = vim.fn.stdpath("data") .. "/undo"

-- Clipboard — sync with system clipboard
opt.clipboard = "unnamedplus"

-- Completion
opt.completeopt = "menu,menuone,noselect"

-- Grep with ripgrep
opt.grepprg = "rg --vimgrep --smart-case"
opt.grepformat = "%f:%l:%c:%m"
```

```lua
-- ~/.config/nvim/lua/config/keymaps.lua
local map = vim.keymap.set
local opts = { noremap = true, silent = true }

-- Window navigation
map("n", "<C-h>", "<C-w>h", opts)
map("n", "<C-j>", "<C-w>j", opts)
map("n", "<C-k>", "<C-w>k", opts)
map("n", "<C-l>", "<C-w>l", opts)

-- Window resizing
map("n", "<C-Up>",    ":resize +2<CR>", opts)
map("n", "<C-Down>",  ":resize -2<CR>", opts)
map("n", "<C-Left>",  ":vertical resize -2<CR>", opts)
map("n", "<C-Right>", ":vertical resize +2<CR>", opts)

-- Buffer navigation
map("n", "<S-l>", ":bnext<CR>", opts)
map("n", "<S-h>", ":bprevious<CR>", opts)
map("n", "<leader>bd", ":bdelete<CR>", opts)

-- Move selected lines up/down in visual mode
map("v", "J", ":m '>+1<CR>gv=gv", opts)
map("v", "K", ":m '<-2<CR>gv=gv", opts)

-- Keep cursor centered on search
map("n", "n", "nzzzv", opts)
map("n", "N", "Nzzzv", opts)

-- Keep paste register on paste over selection
map("x", "<leader>p", '"_dP', opts)

-- File explorer
map("n", "<leader>e", ":Neotree toggle<CR>", opts)

-- Diagnostics navigation
map("n", "[d", vim.diagnostic.goto_prev, opts)
map("n", "]d", vim.diagnostic.goto_next, opts)
map("n", "<leader>d", vim.diagnostic.open_float, opts)

-- Quick save
map("n", "<leader>w", ":w<CR>", opts)
map("n", "<leader>q", ":q<CR>", opts)
```

## Section 3: LSP Configuration

```lua
-- ~/.config/nvim/lua/plugins/lsp.lua
return {
  -- LSP configuration
  {
    "neovim/nvim-lspconfig",
    event = { "BufReadPre", "BufNewFile" },
    dependencies = {
      "williamboman/mason.nvim",
      "williamboman/mason-lspconfig.nvim",
      "hrsh7th/cmp-nvim-lsp",
      { "folke/neodev.nvim", opts = {} },
    },
    config = function()
      -- Mason manages LSP server binaries
      require("mason").setup({
        ui = {
          icons = {
            package_installed = "✓",
            package_pending = "➜",
            package_uninstalled = "✗",
          },
        },
      })

      require("mason-lspconfig").setup({
        ensure_installed = {
          "gopls",           -- Go
          "pyright",         -- Python
          "ts_ls",           -- TypeScript/JavaScript
          "lua_ls",          -- Lua (for Neovim config)
          "bashls",          -- Bash
          "yamlls",          -- YAML (Kubernetes manifests)
          "jsonls",          -- JSON
          "dockerls",        -- Dockerfile
          "terraformls",     -- Terraform
          "helm_ls",         -- Helm charts
        },
        automatic_installation = true,
      })

      local lspconfig = require("lspconfig")
      local capabilities = require("cmp_nvim_lsp").default_capabilities()

      -- Shared LSP on_attach function
      local on_attach = function(client, bufnr)
        local bufopts = { noremap = true, silent = true, buffer = bufnr }
        local map = vim.keymap.set

        -- Navigation
        map("n", "gd", vim.lsp.buf.definition, bufopts)
        map("n", "gD", vim.lsp.buf.declaration, bufopts)
        map("n", "gi", vim.lsp.buf.implementation, bufopts)
        map("n", "gr", vim.lsp.buf.references, bufopts)
        map("n", "gt", vim.lsp.buf.type_definition, bufopts)
        map("n", "K",  vim.lsp.buf.hover, bufopts)
        map("n", "<C-k>", vim.lsp.buf.signature_help, bufopts)

        -- Actions
        map("n", "<leader>rn", vim.lsp.buf.rename, bufopts)
        map("n", "<leader>ca", vim.lsp.buf.code_action, bufopts)
        map("n", "<leader>f",  function() vim.lsp.buf.format({ async = true }) end, bufopts)

        -- Workspace
        map("n", "<leader>wa", vim.lsp.buf.add_workspace_folder, bufopts)
        map("n", "<leader>wr", vim.lsp.buf.remove_workspace_folder, bufopts)

        -- Highlight references on cursor hold
        if client.server_capabilities.documentHighlightProvider then
          vim.api.nvim_create_autocmd({ "CursorHold", "CursorHoldI" }, {
            buffer = bufnr,
            callback = vim.lsp.buf.document_highlight,
          })
          vim.api.nvim_create_autocmd("CursorMoved", {
            buffer = bufnr,
            callback = vim.lsp.buf.clear_references,
          })
        end
      end

      -- Go — gopls with full feature set
      lspconfig.gopls.setup({
        capabilities = capabilities,
        on_attach = on_attach,
        settings = {
          gopls = {
            gofumpt = true,           -- Stricter formatting
            staticcheck = true,
            analyses = {
              unusedparams = true,
              shadow = true,
              fieldalignment = true,
            },
            hints = {
              parameterNames = true,
              assignVariableTypes = true,
              compositeLiteralFields = true,
              compositeLiteralTypes = true,
              constantValues = true,
              functionTypeParameters = true,
              rangeVariableTypes = true,
            },
            codelenses = {
              generate = true,
              gc_details = true,
              test = true,
              tidy = true,
            },
          },
        },
      })

      -- Python — pyright with strict type checking
      lspconfig.pyright.setup({
        capabilities = capabilities,
        on_attach = on_attach,
        settings = {
          python = {
            analysis = {
              typeCheckingMode = "basic",
              autoSearchPaths = true,
              useLibraryCodeForTypes = true,
              diagnosticMode = "workspace",
            },
          },
        },
      })

      -- TypeScript
      lspconfig.ts_ls.setup({
        capabilities = capabilities,
        on_attach = on_attach,
        settings = {
          typescript = {
            inlayHints = {
              includeInlayParameterNameHints = "all",
              includeInlayParameterNameHintsWhenArgumentMatchesName = false,
              includeInlayFunctionParameterTypeHints = true,
              includeInlayVariableTypeHints = true,
            },
          },
        },
      })

      -- YAML with Kubernetes schema validation
      lspconfig.yamlls.setup({
        capabilities = capabilities,
        on_attach = on_attach,
        settings = {
          yaml = {
            schemas = {
              ["https://raw.githubusercontent.com/instrumenta/kubernetes-json-schema/master/v1.18.0-standalone-strict/all.json"] = "/*.k8s.yaml",
              ["https://json.schemastore.org/helmfile.json"] = "helmfile.yaml",
              kubernetes = { "*.yaml", "*.yml" },
            },
            schemaStore = {
              enable = true,
              url = "https://www.schemastore.org/api/json/catalog.json",
            },
            validate = true,
            format = { enable = true },
          },
        },
      })

      -- Bash
      lspconfig.bashls.setup({ capabilities = capabilities, on_attach = on_attach })

      -- Terraform
      lspconfig.terraformls.setup({ capabilities = capabilities, on_attach = on_attach })

      -- Diagnostic display configuration
      vim.diagnostic.config({
        virtual_text = {
          prefix = "●",
          source = "if_many",
        },
        signs = true,
        underline = true,
        update_in_insert = false,
        severity_sort = true,
        float = {
          focusable = false,
          style = "minimal",
          border = "rounded",
          source = "always",
          header = "",
          prefix = "",
        },
      })
    end,
  },
}
```

## Section 4: Autocompletion with nvim-cmp

```lua
-- ~/.config/nvim/lua/plugins/completion.lua
return {
  {
    "hrsh7th/nvim-cmp",
    event = "InsertEnter",
    dependencies = {
      "hrsh7th/cmp-nvim-lsp",
      "hrsh7th/cmp-buffer",
      "hrsh7th/cmp-path",
      "hrsh7th/cmp-cmdline",
      "saadparwaiz1/cmp_luasnip",
      {
        "L3MON4D3/LuaSnip",
        version = "v2.*",
        build = "make install_jsregexp",
        dependencies = { "rafamadriz/friendly-snippets" },
        config = function()
          require("luasnip.loaders.from_vscode").lazy_load()
        end,
      },
      "onsails/lspkind.nvim",
    },
    config = function()
      local cmp = require("cmp")
      local luasnip = require("luasnip")
      local lspkind = require("lspkind")

      cmp.setup({
        snippet = {
          expand = function(args)
            luasnip.lsp_expand(args.body)
          end,
        },
        mapping = cmp.mapping.preset.insert({
          ["<C-b>"] = cmp.mapping.scroll_docs(-4),
          ["<C-f>"] = cmp.mapping.scroll_docs(4),
          ["<C-Space>"] = cmp.mapping.complete(),
          ["<C-e>"] = cmp.mapping.abort(),
          ["<CR>"] = cmp.mapping.confirm({ select = true }),
          ["<Tab>"] = cmp.mapping(function(fallback)
            if cmp.visible() then
              cmp.select_next_item()
            elseif luasnip.expand_or_jumpable() then
              luasnip.expand_or_jump()
            else
              fallback()
            end
          end, { "i", "s" }),
          ["<S-Tab>"] = cmp.mapping(function(fallback)
            if cmp.visible() then
              cmp.select_prev_item()
            elseif luasnip.jumpable(-1) then
              luasnip.jump(-1)
            else
              fallback()
            end
          end, { "i", "s" }),
        }),
        sources = cmp.config.sources({
          { name = "nvim_lsp", priority = 1000 },
          { name = "luasnip",  priority = 750 },
          { name = "buffer",   priority = 500 },
          { name = "path",     priority = 250 },
        }),
        formatting = {
          format = lspkind.cmp_format({
            mode = "symbol_text",
            maxwidth = 50,
            ellipsis_char = "...",
          }),
        },
        experimental = {
          ghost_text = { hl_group = "CmpGhostText" },
        },
      })
    end,
  },
}
```

## Section 5: DAP Debugger Configuration

```lua
-- ~/.config/nvim/lua/plugins/dap.lua
return {
  {
    "mfussenegger/nvim-dap",
    dependencies = {
      "rcarriga/nvim-dap-ui",
      "theHamsta/nvim-dap-virtual-text",
      "nvim-neotest/nvim-nio",
      "leoluz/nvim-dap-go",
      "mfussenegger/nvim-dap-python",
    },
    keys = {
      { "<F5>",  function() require("dap").continue() end,          desc = "DAP: Continue" },
      { "<F10>", function() require("dap").step_over() end,         desc = "DAP: Step Over" },
      { "<F11>", function() require("dap").step_into() end,         desc = "DAP: Step Into" },
      { "<F12>", function() require("dap").step_out() end,          desc = "DAP: Step Out" },
      { "<leader>db", function() require("dap").toggle_breakpoint() end, desc = "DAP: Toggle Breakpoint" },
      { "<leader>dB", function()
          require("dap").set_breakpoint(vim.fn.input("Breakpoint condition: "))
        end, desc = "DAP: Conditional Breakpoint" },
      { "<leader>du", function() require("dapui").toggle() end,     desc = "DAP: Toggle UI" },
      { "<leader>dr", function() require("dap").repl.open() end,    desc = "DAP: Open REPL" },
      { "<leader>dl", function() require("dap").run_last() end,     desc = "DAP: Run Last" },
    },
    config = function()
      local dap = require("dap")
      local dapui = require("dapui")

      -- DAP UI configuration
      dapui.setup({
        icons = { expanded = "▾", collapsed = "▸", current_frame = "▸" },
        layouts = {
          {
            elements = {
              { id = "scopes",      size = 0.25 },
              { id = "breakpoints", size = 0.25 },
              { id = "stacks",      size = 0.25 },
              { id = "watches",     size = 0.25 },
            },
            size = 40,
            position = "left",
          },
          {
            elements = {
              { id = "repl",    size = 0.5 },
              { id = "console", size = 0.5 },
            },
            size = 10,
            position = "bottom",
          },
        },
      })

      -- Virtual text showing variable values inline
      require("nvim-dap-virtual-text").setup({
        enabled = true,
        display_callback = function(variable, _buf, _stackframe, _node)
          local value = variable.value
          if string.len(value) > 50 then
            value = string.sub(value, 1, 50) .. "..."
          end
          return " = " .. value
        end,
      })

      -- Auto-open/close DAP UI
      dap.listeners.after.event_initialized["dapui_config"] = function() dapui.open() end
      dap.listeners.before.event_terminated["dapui_config"] = function() dapui.close() end
      dap.listeners.before.event_exited["dapui_config"] = function() dapui.close() end

      -- Go debugging with Delve
      require("dap-go").setup({
        dap_configurations = {
          {
            type = "go",
            name = "Debug",
            request = "launch",
            program = "${file}",
          },
          {
            type = "go",
            name = "Debug test",
            request = "launch",
            mode = "test",
            program = "${file}",
          },
          {
            type = "go",
            name = "Debug test (go.mod)",
            request = "launch",
            mode = "test",
            program = "./${relativeFileDirname}",
          },
          {
            type = "go",
            name = "Attach to running process",
            request = "attach",
            mode = "local",
            processId = require("dap.utils").pick_process,
          },
        },
        delve = {
          path = "dlv",
          initialize_timeout_sec = 20,
          port = "${port}",
          args = {},
          build_flags = "",
        },
      })

      -- Python debugging
      require("dap-python").setup("~/.virtualenvs/debugpy/bin/python")
    end,
  },
}
```

## Section 6: Telescope Fuzzy Finding

```lua
-- ~/.config/nvim/lua/plugins/telescope.lua
return {
  {
    "nvim-telescope/telescope.nvim",
    cmd = "Telescope",
    version = false,
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
    keys = {
      -- Files
      { "<leader>ff", "<cmd>Telescope find_files<cr>",              desc = "Find Files" },
      { "<leader>fr", "<cmd>Telescope oldfiles<cr>",                desc = "Recent Files" },
      { "<leader>fg", "<cmd>Telescope live_grep<cr>",               desc = "Live Grep" },
      { "<leader>fw", "<cmd>Telescope grep_string<cr>",             desc = "Grep Word Under Cursor" },
      { "<leader>fb", "<cmd>Telescope buffers<cr>",                 desc = "Buffers" },
      -- LSP
      { "<leader>fs", "<cmd>Telescope lsp_document_symbols<cr>",    desc = "Document Symbols" },
      { "<leader>fS", "<cmd>Telescope lsp_workspace_symbols<cr>",   desc = "Workspace Symbols" },
      { "<leader>fd", "<cmd>Telescope diagnostics<cr>",             desc = "Diagnostics" },
      -- Git
      { "<leader>gc", "<cmd>Telescope git_commits<cr>",             desc = "Git Commits" },
      { "<leader>gb", "<cmd>Telescope git_branches<cr>",            desc = "Git Branches" },
      { "<leader>gs", "<cmd>Telescope git_status<cr>",              desc = "Git Status" },
      -- Misc
      { "<leader>fh", "<cmd>Telescope help_tags<cr>",               desc = "Help Tags" },
      { "<leader>fk", "<cmd>Telescope keymaps<cr>",                 desc = "Keymaps" },
      { "<leader>:",  "<cmd>Telescope command_history<cr>",         desc = "Command History" },
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
            "^.git/", "^node_modules/", "^vendor/",
            "^.terraform/", "%.lock$",
          },
          mappings = {
            i = {
              ["<C-j>"] = actions.move_selection_next,
              ["<C-k>"] = actions.move_selection_previous,
              ["<C-q>"] = actions.send_to_qflist + actions.open_qflist,
              ["<esc>"] = actions.close,
            },
          },
          layout_config = {
            horizontal = { preview_width = 0.55 },
            vertical = { mirror = false },
            width = 0.87,
            height = 0.80,
          },
        },
        pickers = {
          find_files = {
            find_command = { "fd", "--type", "f", "--strip-cwd-prefix", "--hidden" },
          },
          live_grep = {
            additional_args = function() return { "--hidden" } end,
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
}
```

## Section 7: Git Integration

```lua
-- ~/.config/nvim/lua/plugins/git.lua
return {
  -- Fugitive for full git operations
  {
    "tpope/vim-fugitive",
    cmd = { "Git", "G", "Gdiffsplit", "Gread", "Gwrite", "GMove", "GDelete", "GBrowse" },
    keys = {
      { "<leader>gg", "<cmd>Git<cr>",             desc = "Git Status (Fugitive)" },
      { "<leader>gd", "<cmd>Gdiffsplit<cr>",      desc = "Git Diff" },
      { "<leader>gl", "<cmd>Git log --oneline<cr>", desc = "Git Log" },
      { "<leader>gp", "<cmd>Git push<cr>",        desc = "Git Push" },
      { "<leader>gP", "<cmd>Git pull<cr>",        desc = "Git Pull" },
      { "<leader>gB", "<cmd>GBrowse<cr>",         desc = "Browse on GitHub" },
    },
  },

  -- Gitsigns for inline blame and hunk operations
  {
    "lewis6991/gitsigns.nvim",
    event = { "BufReadPre", "BufNewFile" },
    opts = {
      signs = {
        add          = { text = "│" },
        change       = { text = "│" },
        delete       = { text = "_" },
        topdelete    = { text = "‾" },
        changedelete = { text = "~" },
        untracked    = { text = "┆" },
      },
      current_line_blame = true,
      current_line_blame_opts = {
        delay = 500,
        virt_text_pos = "eol",
      },
      on_attach = function(bufnr)
        local gs = package.loaded.gitsigns
        local map = function(mode, l, r, desc)
          vim.keymap.set(mode, l, r, { buffer = bufnr, desc = desc })
        end

        -- Navigation
        map("n", "]h", gs.next_hunk,       "Next Hunk")
        map("n", "[h", gs.prev_hunk,       "Prev Hunk")

        -- Actions
        map("n", "<leader>hs", gs.stage_hunk,            "Stage Hunk")
        map("n", "<leader>hr", gs.reset_hunk,            "Reset Hunk")
        map("v", "<leader>hs", function() gs.stage_hunk({vim.fn.line("."), vim.fn.line("v")}) end, "Stage Hunk")
        map("n", "<leader>hS", gs.stage_buffer,          "Stage Buffer")
        map("n", "<leader>hu", gs.undo_stage_hunk,       "Undo Stage Hunk")
        map("n", "<leader>hR", gs.reset_buffer,          "Reset Buffer")
        map("n", "<leader>hp", gs.preview_hunk,          "Preview Hunk")
        map("n", "<leader>hb", function() gs.blame_line({full=true}) end, "Blame Line (Full)")
        map("n", "<leader>hd", gs.diffthis,              "Diff This")
      end,
    },
  },

  -- Diffview for side-by-side diff and merge conflicts
  {
    "sindrets/diffview.nvim",
    cmd = { "DiffviewOpen", "DiffviewClose", "DiffviewToggleFiles", "DiffviewFocusFiles" },
    keys = {
      { "<leader>gD", "<cmd>DiffviewOpen<cr>",       desc = "Diffview Open" },
      { "<leader>gX", "<cmd>DiffviewClose<cr>",      desc = "Diffview Close" },
      { "<leader>gH", "<cmd>DiffviewFileHistory %<cr>", desc = "File History" },
    },
    opts = {
      enhanced_diff_hl = true,
    },
  },
}
```

## Section 8: Treesitter Configuration

```lua
-- ~/.config/nvim/lua/plugins/treesitter.lua
return {
  {
    "nvim-treesitter/nvim-treesitter",
    build = ":TSUpdate",
    event = { "BufReadPre", "BufNewFile" },
    dependencies = {
      "nvim-treesitter/nvim-treesitter-textobjects",
    },
    config = function()
      require("nvim-treesitter.configs").setup({
        ensure_installed = {
          "go", "gomod", "gosum", "gowork",
          "python", "typescript", "javascript", "tsx",
          "lua", "vim", "vimdoc",
          "bash", "dockerfile",
          "yaml", "json", "jsonc", "toml",
          "hcl",            -- Terraform
          "markdown", "markdown_inline",
          "regex", "sql",
          "c", "cpp",
        },
        auto_install = true,
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
              ["aa"] = "@parameter.outer",
              ["ia"] = "@parameter.inner",
              ["ab"] = "@block.outer",
              ["ib"] = "@block.inner",
            },
          },
          move = {
            enable = true,
            set_jumps = true,
            goto_next_start = {
              ["]f"] = "@function.outer",
              ["]c"] = "@class.outer",
            },
            goto_previous_start = {
              ["[f"] = "@function.outer",
              ["[c"] = "@class.outer",
            },
          },
          swap = {
            enable = true,
            swap_next     = { ["<leader>a"] = "@parameter.inner" },
            swap_previous = { ["<leader>A"] = "@parameter.inner" },
          },
        },
      })
    end,
  },
}
```

## Section 9: Status Line and UI

```lua
-- ~/.config/nvim/lua/plugins/ui.lua
return {
  -- Colorscheme
  {
    "catppuccin/nvim",
    name = "catppuccin",
    priority = 1000,
    config = function()
      require("catppuccin").setup({
        flavour = "mocha",
        integrations = {
          cmp = true, gitsigns = true, nvimtree = true,
          telescope = { enabled = true }, treesitter = true,
          native_lsp = {
            enabled = true,
            underlines = {
              errors = { "undercurl" },
              hints = { "underdotted" },
              warnings = { "undercurl" },
            },
          },
        },
      })
      vim.cmd.colorscheme("catppuccin")
    end,
  },

  -- Status line
  {
    "nvim-lualine/lualine.nvim",
    event = "VeryLazy",
    opts = {
      options = {
        theme = "catppuccin",
        component_separators = { left = "", right = "" },
        section_separators = { left = "", right = "" },
        globalstatus = true,
      },
      sections = {
        lualine_a = { "mode" },
        lualine_b = { "branch", "diff", "diagnostics" },
        lualine_c = { { "filename", path = 1 } },
        lualine_x = {
          {
            function()
              local msg = "No LSP"
              local buf_ft = vim.api.nvim_get_option_value("filetype", { buf = 0 })
              local clients = vim.lsp.get_clients({ bufnr = 0 })
              if #clients == 0 then return msg end
              local names = {}
              for _, client in ipairs(clients) do
                if client.config and client.config.filetypes
                  and vim.fn.index(client.config.filetypes, buf_ft) ~= -1 then
                  table.insert(names, client.name)
                end
              end
              return #names > 0 and table.concat(names, ",") or msg
            end,
            icon = " LSP:",
          },
          "encoding",
          "fileformat",
          "filetype",
        },
        lualine_y = { "progress" },
        lualine_z = { "location" },
      },
    },
  },
}
```

## Section 10: Terminal Integration

```lua
-- ~/.config/nvim/lua/plugins/terminal.lua
return {
  {
    "akinsho/toggleterm.nvim",
    version = "*",
    keys = {
      { "<C-\\>", "<cmd>ToggleTerm<cr>", desc = "Toggle Terminal" },
      { "<leader>tf", "<cmd>ToggleTerm direction=float<cr>", desc = "Float Terminal" },
      { "<leader>th", "<cmd>ToggleTerm direction=horizontal<cr>", desc = "Horizontal Terminal" },
      { "<leader>tv", "<cmd>ToggleTerm direction=vertical size=60<cr>", desc = "Vertical Terminal" },
    },
    opts = {
      size = function(term)
        if term.direction == "horizontal" then return 15
        elseif term.direction == "vertical" then return math.floor(vim.o.columns * 0.4)
        end
      end,
      open_mapping = [[<C-\>]],
      hide_numbers = true,
      shade_terminals = true,
      shading_factor = 2,
      start_in_insert = true,
      persist_mode = true,
      direction = "float",
      close_on_exit = true,
      shell = vim.o.shell,
      float_opts = {
        border = "curved",
        winblend = 3,
      },
    },
    config = function(_, opts)
      require("toggleterm").setup(opts)

      -- Custom terminals for common tools
      local Terminal = require("toggleterm.terminal").Terminal

      -- Lazygit integration
      local lazygit = Terminal:new({
        cmd = "lazygit",
        hidden = true,
        direction = "float",
        float_opts = { border = "double" },
        on_open = function(term)
          vim.cmd("startinsert!")
          vim.api.nvim_buf_set_keymap(term.bufnr, "n", "q", "<cmd>close<CR>", { noremap = true, silent = true })
        end,
      })

      vim.keymap.set("n", "<leader>gg", function() lazygit:toggle() end,
        { noremap = true, silent = true, desc = "Lazygit" })
    end,
  },
}
```

## Conclusion

This configuration produces a Neovim environment that competes directly with VS Code on every metric that matters for infrastructure and backend development: accurate type-aware completions, jump-to-definition across dependencies, step-through debugging with variable inspection, fuzzy file and symbol search, and seamless git operations. The entire configuration is version-controlled Lua, meaning you can reproduce your exact environment on a new machine in under five minutes by cloning your dotfiles repo. That portability is the lasting advantage of the terminal-native approach — your IDE follows you into any SSH session, container shell, or cloud instance where work happens.
