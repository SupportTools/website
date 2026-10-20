# support.tools Theme Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the m10c Hugo theme to the approved "Forest Header" design with AA-passing colors (including syntax highlighting), a sidebar table of contents, Copy buttons on code blocks, GitHub-style callouts, and an optional `quick_fix` box, without touching URLs, posts, or agent outputs.

**Architecture:** All colors are CSS custom properties in `_base.scss`; a dependency-free Node script parses them and enforces WCAG AA in CI. Hugo render hooks (`render-codeblock.html`, `render-blockquote.html`) and `single.html` produce all markup server-side; one small ES module (`assets/js/enhance.js`, built with Hugo's bundled esbuild) adds Copy buttons and TOC scroll-spy. Theme tests are `node --test` files that read a drafts-included Hugo build of two fixture posts.

**Tech Stack:** Hugo 0.168.0 extended + Dart Sass (same as CI), Node 20 (`node:test`, `node:assert`, no new npm deps), Pagefind 1.5.2.

**Spec:** `docs/superpowers/specs/2026-10-19-theme-redesign-design.md` (approved 2026-10-19). Visual reference: `docs/superpowers/specs/assets/2026-10-19-theme-redesign/` (`green-direction.html` option G2, `toc-copy.html` TOC option 1 and copy option A). Where a mockup and the spec disagree, the spec wins; mockup JS is not a reference.

## Global Constraints

- Hugo 0.168.0 (pinned in CI), Pagefind 1.5.2, Node 20. No new npm dependencies.
- No new build-time internet fetches. Hugo's `js.Build` uses its bundled esbuild (no fetch). Google Fonts is a runtime browser fetch, not a build fetch.
- WCAG AA: 4.5:1 for text, 3:1 for focus indicators and control boundaries, light and dark mode.
- No changes to URLs, permalinks, menu entries, or any existing post under `blog/content/post/`.
- No em dashes or en dashes in post prose or frontmatter (applies to fixtures and `_template.md`).
- Header is NOT sticky. Only the TOC sidebar is sticky.
- Only fenced code blocks get the header bar and Copy button.
- Copy copies the exact code; never strips prompts or output. No `execCommand` fallback.
- UI text (Copy, Copied, TOC) must not reach per-page Markdown, `llms.txt`, Pagefind, or meta descriptions.
- Everything readable and navigable with JS disabled.
- **Do not commit or push unless the owner asks.** Every "Checkpoint" step below means: run `git status`, confirm only the task's files changed, and commit only if the owner has said to.

## Prerequisites (once, before Task 1)

- [ ] `hugo version` prints `v0.168.0+extended` and `sass --version` works. If not, install the same pinned versions CI uses (`.github/workflows/cloudflare-workers.yml`: `hugo-version: '0.168.0'`, Dart Sass `DART_SASS_VERSION` with its `DART_SASS_SHA256`). Tier: pinned, checksummed upstream fetch on a dev machine, not on the build path.
- [ ] `npm ci` at repo root succeeds.
- [ ] Capture the agent-output baseline before any theme change (used in Task 8):

```bash
cd blog && hugo --minify --gc --destination ../.theme-baseline-public --baseURL https://support.tools >/dev/null && cd ..
```

Add `.theme-baseline-public/` and `.theme-test-public/` to `.gitignore` (same block as `.superpowers/`).

## Review Focus

1. **Summary leakage**: every `.Summary` consumer (meta description, JSON-LD, list excerpts, `llms.txt`) would pick up code header text for posts whose summary contains a fence. Test in Task 4; the Task 8 `llms.txt` byte compare also catches it.
2. **Line-numbered fences** (`{linenos=table}` and `{linenos=inline}`): Copy must return only the code, never the numbers. Test in Task 4.
3. **Dark-mode drift**: `:root[data-theme="dark"]` and the `prefers-color-scheme` block must hold identical values, or OS-dark readers get different colors than toggle-dark readers. Test in Task 1.
4. **Duplicate IDs from the dual-rendered TOC**: `.TableOfContents` emits `id="TableOfContents"`; rendering it twice must not produce duplicate IDs. Test in Task 5.
5. **Alert types beyond NOTE/TIP/WARNING** (`[!CAUTION]`, `[!IMPORTANT]`) and **filename text with HTML characters** (`{filename="a<b>.yaml"}`): fall back to NOTE styling; filename is escaped. Tests in Tasks 6 and 4.

## File Map

| File | Responsibility |
|---|---|
| `scripts/check-contrast.mjs` (create) | Parse tokens from `_base.scss`, check AA pairs, exit 1 on any miss |
| `tests/theme/contrast.test.mjs` (create) | Unit tests for the contrast checker |
| `tests/theme/build-fixtures.mjs` (create) | Build the site with drafts into `.theme-test-public/` |
| `tests/theme/site.mjs` (create) | `readPage(path)` helper for build-output tests |
| `tests/theme/*.test.mjs` (create) | Build-output tests per feature, plus `enhance.test.mjs` |
| `blog/content/post/theme-fixture.md`, `theme-fixture-short.md` (create) | Draft-only fixtures, never published (`draft: true`) |
| `blog/themes/m10c/assets/css/_base.scss` (modify) | Tokens, fonts, focus, utilities |
| `blog/themes/m10c/assets/css/components/_syntax.scss` (create) | Chroma class to token mapping |
| `blog/themes/m10c/assets/css/components/_code_block.scss` (create) | Code header bar and Copy button |
| `blog/themes/m10c/assets/css/components/_toc.scss` (create) | Sidebar and collapsed TOC, post grid (move `.post-toc` rules here from `_post.scss`) |
| `blog/themes/m10c/assets/css/components/_callout.scss` (create) | Alerts and quick fix box |
| `blog/themes/m10c/assets/css/main.scss` (modify) | `@use` the new partials |
| `blog/themes/m10c/assets/js/enhance.js` (create) | Copy buttons and scroll-spy |
| `blog/themes/m10c/layouts/_default/_markup/render-codeblock.html` (create) | Code header bar wrapper |
| `blog/themes/m10c/layouts/_default/_markup/render-blockquote.html` (create) | Alerts |
| `blog/themes/m10c/layouts/_default/single.html` (modify) | TOC, quick fix, grid |
| `blog/themes/m10c/layouts/_default/single.markdown.md` (modify) | Quick fix section |
| `blog/themes/m10c/layouts/_default/baseof.html` (modify) | Fonts, theme-color, live region, script tag |
| `blog/config.toml` (modify) | `[markup.highlight] noClasses = false` |
| `blog/static/css/custom.css` (modify) | `.sections h2` color |
| `blog/_template.md` (modify) | Commented `quick_fix`, alert syntax, filename fence |
| `package.json` (modify) | `check:contrast`, `test:theme` scripts |
| `.github/workflows/cloudflare-workers.yml` (modify) | Contrast step in the Test job |

---

### Task 1: Contrast checker, wired into CI

**Files:**
- Create: `scripts/check-contrast.mjs`, `tests/theme/contrast.test.mjs`
- Modify: `package.json`, `.github/workflows/cloudflare-workers.yml` (Test job, before "Test Hugo build")

**Interfaces:**
- Produces (exported from `scripts/check-contrast.mjs`):
  - `contrastRatio(fg: string, bg: string): number` (hex `#rrggbb`, WCAG 2.x relative luminance)
  - `parseTokens(scss: string): { light: Record<string,string>, dark: Record<string,string>, darkMedia: Record<string,string> }` (keys without the leading `--`; blocks are `:root {`, `:root[data-theme="dark"] {`, and `:root:not([data-theme]) {` inside the `prefers-color-scheme: dark` media block)
  - `PAIRS: Array<{ fg: string, bg: string, min: 4.5 | 3 }>` (token names)
  - `check(tokens): string[]` returns failure messages (`"dark: syntax-kw on color-code-surface 3.10 < 4.5"`), including one per key whose `dark` and `darkMedia` values differ, or that is missing from either mode
  - CLI: `node scripts/check-contrast.mjs [path]` (default `blog/themes/m10c/assets/css/_base.scss`), prints failures, exits 1 if any
- `PAIRS` (both modes; Task 2 creates every token named here):
  - 4.5: `color-ink`, `color-muted`, `color-accent`, `color-visited` on `color-canvas`; `color-ink`, `color-muted`, `color-accent` on `color-surface`; `syntax-text`, `syntax-kw`, `syntax-str`, `syntax-fn`, `syntax-com`, `syntax-num`, `color-muted` on `color-code-surface`; `color-chip-ink` on `color-chip`; `color-on-button` on `color-button`; `color-header-ink`, `color-header-muted` on `color-header`; `color-warn-ink`, `color-ink` on `color-warn-bg`; `color-ink` on `color-selection`
  - 3: `color-focus` on `color-canvas`, `color-focus` on `color-code-surface`, `color-header-focus` on `color-header`, `color-warn-line` on `color-canvas`, `color-border-strong` on `color-canvas`

- [ ] **Step 1: Write the failing tests** in `tests/theme/contrast.test.mjs`:
  - `contrastRatio('#000000', '#ffffff')` is 21 (to 2 decimals); `contrastRatio('#60a818', '#ffffff')` rounds to 2.95; argument order does not matter.
  - `parseTokens` on an inline SCSS string with all three blocks returns the three maps; values are lowercased.
  - `check` on tokens where `syntax-kw` is `#e6db74` on code surface `#edf1ed` returns a message containing `syntax-kw` and `4.5`.
  - `check` reports a drift message when `darkMedia['color-ink']` differs from `dark['color-ink']`.
  - `check` reports a missing token (`PAIRS` names a token absent in a mode) instead of throwing.
- [ ] **Step 2: Run, expect FAIL** (module not found): `node --test tests/theme/contrast.test.mjs`
- [ ] **Step 3: Implement** `scripts/check-contrast.mjs` (ESM; `import.meta.url === pathToFileURL(process.argv[1]).href` guards the CLI). Parse with regex per block; ignore non-hex values.
- [ ] **Step 4: Run, expect PASS:** `node --test tests/theme/contrast.test.mjs`
- [ ] **Step 5: Add scripts** to `package.json`: `"check:contrast": "node scripts/check-contrast.mjs"`, `"test:theme": "node tests/theme/build-fixtures.mjs && node --test tests/theme/"` (the build script arrives in Task 3; until then run test files directly).
- [ ] **Step 6: Run against today's theme, expect FAIL:** `npm run check:contrast` exits 1, listing at least missing `syntax-*` tokens and `color-focus` (#e4a11b). This is the red state Task 2 turns green.
- [ ] **Step 7: Add the CI step** to the Test job of `.github/workflows/cloudflare-workers.yml`, after `npm ci` and before "Test Hugo build": `- name: Check theme color contrast` / `run: npm run check:contrast`. No new fetch (Node already installed).
- [ ] **Step 8: Checkpoint.**

### Task 2: Forest Header palette, fonts, header

**Files:**
- Modify: `blog/themes/m10c/assets/css/_base.scss`, `blog/themes/m10c/assets/css/components/_app.scss` (header border `#315442`, focus inside header), `blog/themes/m10c/layouts/_default/baseof.html`, `blog/static/css/custom.css`

**Interfaces:**
- Consumes: `npm run check:contrast` (Task 1).
- Produces: every token in Task 1's `PAIRS`, plus `color-lime` (#60a818, both modes; decorative only), `color-warn-line`, `syntax-*`, and a `.visually-hidden` utility class in `_base.scss`. Later tasks use only these names.

Token values (light / dark). Keep existing names where listed; others are new.

| Token | Light | Dark |
|---|---|---|
| color-canvas | #ffffff | #0e1511 |
| color-surface | #ffffff | #131c16 |
| color-ink | #111a12 | #e3ece5 |
| color-muted, color-summary | #4b5a4d | #a3b5a7 |
| color-border | #e1e7e0 | #2a3a2f |
| color-border-strong | #7d8f80 | #5f7464 |
| color-accent | #2e6b0e | #8fd14f |
| color-accent-strong (hover) | #1f4d08 | #b2e47f |
| color-visited | #514682 | #c9b8ff |
| color-focus | #2e6b0e | #8fd14f |
| color-lime | #60a818 | #60a818 |
| color-chip / color-chip-ink | #eaf4df / #285e0c | #1f3315 / #b9e68a |
| color-button / color-on-button (alias color-on-accent) | #2e6b0e / #ffffff | #8fd14f / #0f1a08 |
| color-code (inline code) | #1c2b1e | #dfe9e1 |
| color-code-surface | #f4f7f1 | #151f18 |
| color-selection | #dcefc8 | #2f4a22 |
| color-soft | #eaf4df | #1f3315 |
| color-mark | #ffe29a | #745a20 |
| color-header / color-header-ink / color-header-muted | #10261b / #ffffff / #c3d6c8 | #07100b / #ffffff / #b4c8b9 |
| color-header-focus | #ffffff | #ffffff |
| color-warn-bg / color-warn-line / color-warn-ink | #fdf6e3 / #a16207 / #7c4a03 | #2a2412 / #e0b04a / #f3d38a |
| syntax-text / kw / str / fn / com / num | #1c2b1e / #9f1d4f / #1d5c2e / #5b3cc4 / #55665a / #0b5394 | #dfe9e1 / #ff8fb3 / #a6dd6b / #c4b5fd / #93a596 / #8cc8ff |

- [ ] **Step 1: Replace token values** in all three blocks of `_base.scss` (dark and media blocks identical). Set `--font-body: "IBM Plex Sans", sans-serif;` and `--font-code: "IBM Plex Mono", monospace;`.
- [ ] **Step 2: Run, expect PASS:** `npm run check:contrast` exits 0.
- [ ] **Step 3: Focus inside the header** uses `--color-header-focus` (`.site-header a:focus-visible, .site-header button:focus-visible`), since `color-focus` on the header is 2.45:1. Header border uses `--color-border` mixed toward the header or is removed (decorative). Active nav link gets a 3px `--color-lime` underline (mockup G2).
- [ ] **Step 4: Fonts link** in `baseof.html`: `family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400&display=swap`.
- [ ] **Step 5: theme-color** `#ffffff` light, `#0e1511` dark in both the `<meta>` and the toggle script (`themeColor.setAttribute`).
- [ ] **Step 6: Bean in a white circle:** `.site-brand-avatar { background: #ffffff; border-radius: 50%; padding: 2px; }`.
- [ ] **Step 7: `custom.css`:** `.sections h2 { color: var(--color-accent); }`.
- [ ] **Step 8: Add `.visually-hidden`** (clip pattern) to `_base.scss`.
- [ ] **Step 9: Verify visually:** `cd blog && hugo server --bind 0.0.0.0` and compare home and one post against `green-direction.html` G2 in both modes. Expected: forest header, white page, dark green links, no gold focus ring.
- [ ] **Step 10: Checkpoint.**

### Task 3: Theme-colored syntax highlighting, fixture build harness

**Files:**
- Modify: `blog/config.toml`, `blog/themes/m10c/assets/css/main.scss`, `blog/themes/m10c/assets/css/components/_post.scss` (code block surface rule)
- Create: `blog/themes/m10c/assets/css/components/_syntax.scss`, `tests/theme/build-fixtures.mjs`, `tests/theme/site.mjs`, `tests/theme/syntax.test.mjs`, `blog/content/post/theme-fixture.md`, `blog/content/post/theme-fixture-short.md`

**Interfaces:**
- Produces:
  - `tests/theme/build-fixtures.mjs`: runs `hugo --buildDrafts --gc --destination ../.theme-test-public --baseURL http://localhost/` in `blog/`; exits non-zero on Hugo failure.
  - `tests/theme/site.mjs`: `readPage(urlPath: string): string` reads `.theme-test-public/<urlPath>/index.html` (or the exact file when `urlPath` ends in `.md`/`.txt`); throws `"run npm run test:theme first"` if the dir is missing.
  - Fixtures at `/theme-fixture/` and `/theme-fixture-short/` (`draft: true`, `noindex: true`). Later tasks add to `theme-fixture.md`; its sections are fixed here:
    - frontmatter `description: "Theme fixture"`; four `##` headings and one `###`
    - fences: ```` ```bash ```` (contains `$ kubectl get pods` and an output line), ```` ```yaml {filename="longhorn-settings.yaml"} ````, ```` ```yaml {filename="a<b>.yaml"} ````, an unlabeled fence, ```` ```go {linenos=table} ````, ```` ```go {linenos=inline} ````, a mermaid fence
    - a raw HTML `<pre>` block
    - `theme-fixture-short.md`: no `description`, two `##` headings, a ```` ```bash ```` fence before `<!--more-->`

- [ ] **Step 1: Write fixtures and harness** as above. No em or en dashes.
- [ ] **Step 2: Write the failing test** `syntax.test.mjs`:
  - `readPage('theme-fixture')` contains `class="chroma"` and matches no `/<span style="color:/`.
  - Every `class="..."` token inside `.chroma` spans in the fixture page is in the set mapped by `_syntax.scss` (read the SCSS, collect `.chroma .X` selectors) or explicitly listed as "falls back to text"; the test prints unmapped classes.
- [ ] **Step 3: Run, expect FAIL:** `npm run test:theme` (inline `style="color:` present).
- [ ] **Step 4: Add to `config.toml`:** `[markup.highlight]` with `noClasses = false` (inside `[markup]`).
- [ ] **Step 5: Write `_syntax.scss`:** `.chroma { color: var(--syntax-text); background: var(--color-code-surface); }`, then keyword family (`.k .kc .kd .kn .kp .kr .kt .nt .ow`) to `--syntax-kw`; string family (`.s .sa .sb .sc .dl .sd .s2 .se .sh .si .sx .sr .s1 .ss`) to `--syntax-str`; names (`.nf .fm .nc .nb .bp .nd .ne .nx .na .nl .nn`) to `--syntax-fn`; comments (`.c .ch .cm .c1 .cs .cp .cpf`, italic) to `--syntax-com`; literals (`.m .mb .mf .mh .mi .il .mo .no`) to `--syntax-num`; `.ln .lnt` to `--color-muted` with `user-select: none`; `.err` gets no red background. `@use` it in `main.scss`. Code surface in `_post.scss` keeps `border-left: 0.3rem solid var(--color-lime)` (decorative, matches mockup).
- [ ] **Step 6: Run, expect PASS:** `npm run test:theme`. Also `grep -rl 'style="color' .theme-test-public --include=index.html | wc -l` prints `0`.
- [ ] **Step 7: Checkpoint.**

### Task 4: Code block header bar and Copy

**Files:**
- Create: `blog/themes/m10c/layouts/_default/_markup/render-codeblock.html`, `blog/themes/m10c/assets/css/components/_code_block.scss`, `blog/themes/m10c/assets/js/enhance.js`, `tests/theme/codeblock.test.mjs`, `tests/theme/enhance.test.mjs`
- Create: `blog/themes/m10c/layouts/partials/plain-summary.html`
- Modify: `baseof.html` (live region, script, meta description), `main.scss`, `partials/structured-data.html:12`, `_default/list.html:30`, `home.llms.txt:18`

**Interfaces:**
- Consumes: tokens (Task 2), fixtures and `readPage` (Task 3), `.visually-hidden`.
- Produces markup per fenced block:

```html
<div class="code-block" data-copy-label="Copy yaml code from longhorn-settings.yaml">
  <div class="code-block-header" data-pagefind-ignore>
    <span class="code-block-lang">yaml</span>
    <span class="code-block-filename">longhorn-settings.yaml</span>
    <!-- enhance.js appends: <button type="button" class="code-copy" aria-label="(data-copy-label)">Copy</button> -->
  </div>
  <!-- transform.Highlight output (div.highlight) -->
</div>
```

  - Label rules: lang and filename: `Copy {lang} code from {filename}`; lang only: `Copy {lang} code, block {n}`; neither: `Copy code, block {n}`. `{n}` is `.Ordinal + 1`. Omit `.code-block-lang` when there is no language; omit `.code-block-filename` when there is no filename. Both values HTML-escaped.
  - Mermaid fences stay with `render-codeblock-mermaid.html` (Hugo picks the language-specific hook first).
  - `baseof.html`, just before `</body>`: `<div id="copy-status" class="visually-hidden" role="status" aria-live="polite" aria-atomic="true" data-pagefind-ignore></div>` and `<script type="module" src="{{ $js.RelPermalink }}"></script>` where `$js := resources.Get "js/enhance.js" | js.Build (dict "format" "esm" "minify" true) | fingerprint`.
  - `partials/plain-summary.html`: takes a page, returns `.Summary` with every `<div class="code-block-header"...>...</div>` removed (`replaceRE` non-greedy; the header holds only spans), then `plainify | htmlUnescape`. Callers keep their own `truncate`. Replace the four `.Summary | plainify` uses (meta description in `baseof.html`, `structured-data.html`, `list.html`, `home.llms.txt`) with `partial "plain-summary.html" .` so the language and filename labels never reach descriptions, list excerpts, or `llms.txt`. `home.llms.txt` currently also applies `htmlUnescape`; the partial does it once for everyone (check the other three outputs still escape correctly in their HTML attribute contexts).
  - `enhance.js` exports (pure, unit-tested): `statusText(ok: boolean): string` returns `"Copied to clipboard"` or `"Copy failed, select the code manually"`; and `codeTextFrom(root: Element): string` is DOM code, not unit-tested (the browser check below covers it).
  - Copy behavior: text is the `code` element of the last `td.lntd` when present, else the block's `pre code`; clone it and remove `.ln` spans first. Strip exactly one trailing `\n`. `navigator.clipboard.writeText` then: button text `Copied` for 2s, status region set to `statusText(true)`; on reject or missing API: button text `Copy failed`, status `statusText(false)`. Focus stays on the button. Script does nothing in browsers without `navigator.clipboard` beyond inserting buttons that report failure.

- [ ] **Step 1: Write failing tests** `codeblock.test.mjs` against `theme-fixture`:
  - 6 `.code-block` wrappers (mermaid and raw `<pre>` excluded).
  - The filename block has `data-copy-label="Copy yaml code from longhorn-settings.yaml"`.
  - The `a<b>.yaml` block contains `a&lt;b&gt;.yaml` and no `<b>` tag.
  - The unlabeled block has no `.code-block-lang` and label `Copy code, block N`.
  - Every `.code-block-header` has `data-pagefind-ignore`.
  - No `<button` inside any `.code-block` in the built HTML (button is JS-inserted).
  - `readPage('theme-fixture-short')` `<meta name="description"` content does not contain `Copy` or `bash`; neither does its entry in `readPage('llms.txt')` nor its excerpt on `readPage('post')` (the post list page, if the drafted fixture appears there; otherwise `readPage('categories/<fixture category>')`).
  - `readPage('theme-fixture/index.md')` contains the original ```` ```yaml {filename="longhorn-settings.yaml"} ```` fence text unchanged.
  - `enhance.test.mjs`: `statusText(true)` and `statusText(false)` equal the exact strings above.
- [ ] **Step 2: Run, expect FAIL:** `npm run test:theme`.
- [ ] **Step 3: Implement** the hook (use `.Type`, `.Attributes.filename`, `.Ordinal`, `transform.Highlight .Inner .Type .Options`), the SCSS (header bar: `--color-code-surface` background, `--color-border` bottom line, lang in `--color-muted` small caps, filename in `--font-code`; button styled with `--color-border-strong` boundary and `--color-focus` ring; `@media print { .code-copy { display: none; } }`), the live region, and `enhance.js`.
- [ ] **Step 4: Run, expect PASS:** `npm run test:theme`.
- [ ] **Step 5: Browser check** (Chrome DevTools MCP or by hand) on `hugo server` at `http://localhost:1313/theme-fixture/` (localhost counts as a secure context): Copy on the `linenos=table` block and on the `linenos=inline` block, paste into the console with `navigator.clipboard.readText()`, and confirm no line numbers and an exact match to the fixture source; the bash block keeps `$ ` and the output line. Tab to a Copy button; the focus ring is visible.
- [ ] **Step 6: Checkpoint.**

### Task 5: Sidebar TOC with scroll-spy

**Files:**
- Create: `blog/themes/m10c/assets/css/components/_toc.scss`, `tests/theme/toc.test.mjs`
- Modify: `single.html`, `_post.scss` (remove `.post-toc` rules), `_app.scss` (`.app-container > article` max-width), `enhance.js`, `tests/theme/enhance.test.mjs`, `main.scss`

**Interfaces:**
- Consumes: fixtures, `enhance.js` module (Task 4).
- Produces:
  - In `single.html`: `$toc := replaceRE ` id="TableOfContents"` "" .TableOfContents`; `$tocCount := len (findRE "<a href=" .TableOfContents)`; show the TOC when `$tocCount` is 3 or more (replaces the `WordCount > 700` rule).
  - Structure: `<article class="post">` keeps breadcrumbs and header, then `<div class="post-layout">` containing `<div class="post-main">` (quick fix slot, collapsed `<details class="post-toc" data-pagefind-ignore>`, `.post-content`, footer) and `<nav class="toc-sidebar" aria-label="On this page" data-pagefind-ignore>` with the same `$toc`.
  - CSS: below 72rem `.toc-sidebar { display: none; }`. At 72rem and up: `.post-toc { display: none; }`; `.post-layout { display: grid; grid-template-columns: minmax(0, 70ch) 16rem; gap: 3rem; }`; `.toc-sidebar { position: sticky; top: 1.5rem; max-height: calc(100vh - 3rem); overflow: auto; }`; `.app-container > article.post { max-width: none; }`. Headings in `.post-content` get `scroll-margin-top: 1rem`. Print: hide `.toc-sidebar` and `.post-toc`.
  - Active link: `aria-current="location"`, styled with a 3px `--color-lime` left border and `--color-ink` text.
  - `enhance.js` export: `pickActive(visibleIds: Set<string>, orderedIds: string[], previous: string | null): string | null` returns the first id in `orderedIds` that is in `visibleIds`, or `previous` when none are visible. The observer only updates `aria-current`; no focus, `history`, or live-region writes.

- [ ] **Step 1: Write failing tests:** `toc.test.mjs`:
  - `theme-fixture` has exactly one `nav.toc-sidebar[aria-label="On this page"]` and one `details.post-toc`, both with `data-pagefind-ignore`.
  - `theme-fixture` has zero occurrences of `id="TableOfContents"`, and no `id` value appears twice in the page.
  - `theme-fixture-short` (2 headings) has no `toc-sidebar` and no `post-toc`.
  - `theme-fixture/index.md` contains neither `On this page` nor `toc-sidebar`.
  - `enhance.test.mjs`: `pickActive(new Set(['b','c']), ['a','b','c'], 'a')` is `'b'`; with an empty set it returns `'a'`; with an empty set and `null` it returns `null`.
- [ ] **Step 2: Run, expect FAIL:** `npm run test:theme`.
- [ ] **Step 3: Implement** the template, CSS, and scroll-spy (`IntersectionObserver` on the headings that the TOC links to, `rootMargin: "0px 0px -70% 0px"`).
- [ ] **Step 4: Run, expect PASS:** `npm run test:theme`.
- [ ] **Step 5: Browser check** at 1280px and 390px widths: the sidebar sticks and the active link follows the scroll; at 390px the collapsed box shows above the article. With JS disabled (DevTools), the TOC links still jump to sections. At 400% zoom there is no horizontal page scroll.
- [ ] **Step 6: Checkpoint.**

### Task 6: Callouts

**Files:**
- Create: `blog/themes/m10c/layouts/_default/_markup/render-blockquote.html`, `blog/themes/m10c/assets/css/components/_callout.scss`, `tests/theme/callout.test.mjs`
- Modify: `theme-fixture.md` (add a `## Callouts` section with `> [!NOTE]`, `> [!TIP]`, `> [!WARNING]`, `> [!CAUTION]`, and a plain blockquote), `main.scss`

**Interfaces:**
- Produces: for `.Type "alert"`, `<aside class="callout callout-{kind}" aria-label="{Label}"><p class="callout-label">{Label}</p>{{ .Text }}</aside>` where `kind` is `note`, `tip`, or `warning`; any other `.AlertType` maps to `note` with the label `Note`. Labels: `Note`, `Tip`, `Warning`. Plain blockquotes render `<blockquote>{{ .Text }}</blockquote>` unchanged.
- Colors: warning uses `--color-warn-bg`, `--color-warn-line` (4px left border), `--color-warn-ink` label; note and tip use `--color-chip` background, `--color-accent` border, `--color-chip-ink` label.

- [ ] **Step 1: Write failing tests** `callout.test.mjs`:
  - `theme-fixture` has `aside.callout-note`, `aside.callout-tip`, and `aside.callout-warning`, each with its visible label text; the CAUTION alert renders as `callout-note` with label `Note`.
  - The plain blockquote is still a `<blockquote>`.
  - `theme-fixture/index.md` still contains `> [!WARNING]`.
- [ ] **Step 2: Run, expect FAIL:** `npm run test:theme`.
- [ ] **Step 3: Implement** the hook and SCSS.
- [ ] **Step 4: Run, expect PASS:** `npm run test:theme`, and `npm run check:contrast` still exits 0.
- [ ] **Step 5: Checkpoint.**

### Task 7: Optional `quick_fix`

**Files:**
- Modify: `single.html` (quick fix slot from Task 5), `single.markdown.md`, `_callout.scss`, `theme-fixture.md` (add `quick_fix: "Scale the deployment to zero, then back to one: \`kubectl scale deploy/app --replicas=0\`"`), `tests/theme/quickfix.test.mjs` (create)

**Interfaces:**
- Produces: when `.Params.quick_fix` is set, `<section class="quick-fix" aria-labelledby="quick-fix-title"><h2 id="quick-fix-title" class="quick-fix-title">Quick fix</h2>{{ .Params.quick_fix | markdownify }}</section>` at the top of `.post-main`, above the collapsed TOC. Note the `<h2>` is outside `.post-content`, so it is not in `.TableOfContents`. In `single.markdown.md`, after the frontmatter: `## Quick fix\n\n{{ .Params.quick_fix }}\n\n` then the existing `{{ .RenderShortcodes }}`.
- Style: `--color-chip` background, 4px `--color-lime` left border, title in `--color-chip-ink`.

- [ ] **Step 1: Write failing tests** `quickfix.test.mjs`:
  - `theme-fixture` contains `section.quick-fix` with `Quick fix` and a `<code>kubectl scale deploy/app --replicas=0</code>`.
  - `theme-fixture-short` contains no `quick-fix`.
  - `theme-fixture/index.md` contains `## Quick fix` followed by the raw field text; `theme-fixture-short/index.md` does not contain `Quick fix`.
- [ ] **Step 2: Run, expect FAIL:** `npm run test:theme`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS:** `npm run test:theme`.
- [ ] **Step 5: Checkpoint.**

### Task 8: Authoring docs, full verification

**Files:**
- Modify: `blog/_template.md` (commented examples only, below the frontmatter fields: `# quick_fix: "One or two sentences with the exact command and the version it applies to"`; in the body an HTML comment showing `> [!WARNING]` and a ```` ```yaml {filename="example.yaml"} ```` fence)

- [ ] **Step 1: Update `_template.md`.** No em or en dashes.
- [ ] **Step 2: Full production build passes:** `npm run build:hugo -- --panicOnWarning && npm run build:search`.
- [ ] **Step 3: Agent outputs unchanged:** `(cd .theme-baseline-public && find . -name '*.md' -exec sh -c 'cmp -s "$1" "../blog/public/$1" || echo "DIFF $1"' _ {} \;)` and `cmp .theme-baseline-public/llms.txt blog/public/llms.txt`. Expected: no `DIFF` lines and `cmp` silent (no published post sets `quick_fix`).
- [ ] **Step 4: Pagefind is clean:** `grep -c 'data-pagefind-ignore' blog/public/<a long post>/index.html` is at least 3 (TOC x2, code headers), and on `hugo server` the search page for `Copy` returns no snippet showing the word `Copy` from a code header.
- [ ] **Step 5: Accessibility audit:** Lighthouse accessibility (Chrome DevTools MCP `lighthouse_audit`) on `/`, `/categories/`, `/search/`, and two long posts, light and dark. Expected: no color-contrast, button-name, or duplicate-id failures.
- [ ] **Step 6: Keyboard and screen reader pass:** Tab from the skip link through the header to the TOC, jump to a section, Tab to a Copy button, press Enter; the status region announces "Copied to clipboard" (check with the DevTools accessibility tree or a screen reader).
- [ ] **Step 7: No-JS and print:** with JS disabled, a long post shows no Copy buttons and the TOC works; print preview hides Copy buttons and the sidebar.
- [ ] **Step 8: Contrast gate proves itself:** temporarily set `--syntax-kw` to `#e6db74` in the light block, run `npm run check:contrast` (expect exit 1 naming `syntax-kw`), then revert and rerun (exit 0).
- [ ] **Step 9: Remove the fixture build output** (`rm -rf .theme-test-public`); keep `.theme-baseline-public` until the owner confirms the release, then delete it.
- [ ] **Step 10: Checkpoint, then report** each spec success criterion (spec section 10) with its evidence.
