# support.tools theme redesign: design

Date: 2026-10-19
Status: approved by owner 2026-10-19
Theme: `blog/themes/m10c` (Hugo 0.168.0, pinned in `.github/workflows/cloudflare-workers.yml`)

## 1. Intent and why

Readers struggle to read the site. The owner's concrete complaint is colors, "yellow text on white."
The root cause is verified: `blog/config.toml` has no `[markup.highlight]`, so Hugo renders every code
block with Chroma's default **monokai** style as inline `style="color:..."`. That dark-theme palette is
painted onto the light code surface (`--color-code-surface` #edf1ed in `_base.scss`). Measured contrast:
base text 1.07:1, strings (#e6db74, the "yellow") 1.25:1, functions 1.36:1, keywords 1.45:1. WCAG AA
needs 4.5:1. This affects the code on effectively every post.

The redesign fixes that, plus the smaller contrast failures, and takes the chance to make the site
easier to use for people looking for a fix, more accessible (WCAG 2.2 AA), and cleaner for agents.

## 2. Goals

1. Every text color, light and dark mode, including all syntax colors, passes WCAG AA (4.5:1 text,
   3:1 non-text and focus indicators).
2. New visual identity, "Forest Header" (option G2, chosen by owner), keeping the site's greens and
   the bean avatar logo.
3. Long posts are navigable: a table of contents that stays reachable while reading.
4. Every code block has a visible, keyboard-accessible Copy button.
5. Agent and machine outputs (per-page Markdown, `llms.txt`, Pagefind index) stay free of UI noise.
6. Works with JavaScript disabled; JS only enhances.

## 3. Non-goals

- No change to URLs, permalinks, content sections, menu entries, or frontmatter of existing posts.
- No migration off Hugo or off the m10c theme structure ("fresh look, same bones").
- No bulk editing of the 2,905 posts in `blog/content/post/`.
- No new search engine; Pagefind (1.5.2) stays.
- No change to the Go server, Helm charts, or Cloudflare Worker.

## 4. Anti-goals (failure even if it "works")

- Any copy feature that rewrites what the reader copies (stripping prompts, dropping output lines).
  Posts mix promptless blocks, `$ ` prompts (20 posts), `user@host:$`, root `#`, heredocs and output.
- Content that only exists after JS runs, or a TOC hidden behind a popover/dialog.
- Hover-only controls.
- "Copy" / "Copied" / language labels showing up in search snippets, Markdown output, or `llms.txt`.
- A required per-post field that 2,905 posts would have to backfill.

## 5. Decisions made by the owner

| Topic | Decision |
|---|---|
| Scope | Full redesign together: colors, a11y, usability, agents in one design |
| Look | Fresh look, same bones |
| Identity | Option G2 "Forest Header": dark forest header band, white page, green accents |
| Logo | The bean avatar (`params.avatar`) |
| TOC | Option 1: sticky right sidebar on wide screens, collapsed native `<details>` otherwise (Codex-reviewed, owner said "do it") |
| Copy | Option A: slim header bar on each code block, always-visible Copy button, exact copy |
| Quick fix | Optional authored frontmatter field only; never generated |
| Header | Not sticky; scrolls away as today. Only the TOC sidebar is sticky |
| Contrast check | Fails CI in the Test job of `cloudflare-workers.yml` |
| Callouts | Support GitHub alert syntax `> [!NOTE]`, `> [!TIP]`, `> [!WARNING]` |
| Docker image | `pipeline.yml` / `Dockerfile` build is retired; ignore it |

## 6. Design

### 6.1 Color tokens

Replace the token values in `themes/m10c/assets/css/_base.scss` (`:root`, `[data-theme="dark"]`, and
the `prefers-color-scheme: dark` block, which must stay in sync). Token names may be kept or renamed;
values below are the contract. All pairs were verified AA with a contrast script during brainstorming
(lowest pair about 5.4:1).

| Role | Light | Dark |
|---|---|---|
| Page background | #ffffff | #0e1511 |
| Body text (ink) | #111a12 | #e3ece5 |
| Muted text | #4b5a4d | #a3b5a7 |
| Hairlines / borders | #e1e7e0 | #2a3a2f (decorative; a control boundary needs 3:1) |
| Accent text and links | #2e6b0e | #8fd14f |
| Bean lime (fills, bars, borders only, never text on white: 2.95:1) | #60a818 | #60a818 |
| Chip / tag | bg #eaf4df, text #285e0c | bg #1f3315, text #b9e68a |
| Code surface | #f4f7f1 | #151f18 |
| Focus ring | #2e6b0e | #8fd14f |
| Header band | #10261b, text #ffffff, muted #c3d6c8 | #07100b, text #ffffff, muted #b4c8b9 |
| Primary button | bg #2e6b0e, text #ffffff | bg #8fd14f, text #0f1a08 |
| Warning callout | bg #fdf6e3, line #a16207, label #7c4a03 | bg #2a2412, line #e0b04a, label #f3d38a |

Syntax tokens:

| Token | Light | Dark |
|---|---|---|
| text | #1c2b1e | #dfe9e1 |
| keyword | #9f1d4f | #ff8fb3 |
| string | #1d5c2e | #a6dd6b |
| function / name | #5b3cc4 | #c4b5fd |
| comment (italic) | #55665a | #93a596 |
| number / literal | #0b5394 | #8cc8ff |

Also fix the known small failures: `static/css/custom.css` `.sections h2` (#57cc8a, 2.02:1) and the
focus ring (#e4a11b, 2.23:1).

### 6.2 Syntax highlighting

Add to `blog/config.toml`:

```toml
[markup.highlight]
  noClasses = false
```

Then style Chroma classes (`.chroma .k`, `.s`, `.nf`, `.c`, `.m`, etc.) from the syntax tokens above,
so code follows the light/dark toggle. Do not generate a Chroma stylesheet with `hugo gen chromastyles`
and ship it as-is; map classes to tokens by hand so there is one source of color truth. Every Chroma
class Hugo emits must resolve to one of the six tokens (unmapped classes fall back to `text`).

### 6.3 Typography and layout

- Fonts: IBM Plex Sans (body, headings) and IBM Plex Mono (code), replacing Source Sans 3 and
  JetBrains Mono in the Google Fonts link in `baseof.html`. Runtime browser fetch, not a build fetch.
- Header: full-width forest band, bean in a white circle (existing `site-brand-avatar`), white nav text.
  Keep the existing menu items and mobile behavior from commit 27a54394.
- Article column stays `max-width: 70ch`. On wide screens the post page becomes a two-column grid:
  article plus a 14 to 18rem TOC sidebar. The outer container cap must grow to allow this.

### 6.4 Table of contents

- Server-rendered from `.TableOfContents`. Show when the post has 3 or more headings at the TOC
  levels, replacing the current `WordCount > 700` rule in `single.html`.
- At about 72rem viewport and wider: sticky right sidebar, labelled `<nav aria-label="On this page">`,
  `max-height` with `overflow: auto`, no keyboard trap.
- Below that: the existing collapsed `<details class="post-toc">` above the article.
- Only one TOC in the accessibility tree at a time (render once and move it with CSS grid, or render
  twice with the hidden one removed via `display: none`; builder's call).
- Headings get a small `scroll-margin-top` (the header is not sticky; this is breathing room only).
- Sidebar `top` is a small fixed offset, `max-height: calc(100vh - offset)`.
- Enhancement JS: `IntersectionObserver` scroll-spy sets `aria-current="location"` on the active link.
  No live-region announcements, no focus moves, no `history` writes.
- `data-pagefind-ignore` on the TOC.

### 6.5 Code blocks and Copy

- New `themes/m10c/layouts/_default/_markup/render-codeblock.html` (the existing
  `render-codeblock-mermaid.html` keeps handling mermaid).
- Output: a wrapper with a header bar showing the language (omit when the fence has none; never
  invent "text"), an optional filename from a fence attribute, and a Copy button; then the normal
  highlighted code via `transform.Highlight`.
- New optional fence attribute: ```` ```yaml {filename="longhorn-settings.yaml"} ````. Display only,
  escaped normally. No existing post uses it; no backfill.
- Copy button: `<button type="button">` with visible text "Copy" and a contextual `aria-label`, for
  example "Copy YAML code from longhorn-settings.yaml" or "Copy bash code, block 3".
- Copies the exact code text, excluding header UI and any line-number markup.
- Clipboard: `navigator.clipboard.writeText` (production is HTTPS). On failure, show and announce an
  error ("Copy failed, select the code manually"). Never announce success unless the write resolved.
  No `execCommand` fallback.
- One shared visually hidden `aria-live="polite" aria-atomic="true"` region for status. Focus stays on
  the button.
- Without JS, the Copy button is not shown (render it hidden and reveal from JS, or insert it from JS).
- `data-pagefind-ignore` on the header bar. Hide the header bar's button in print.

### 6.6 Callouts

- New `themes/m10c/layouts/_default/_markup/render-blockquote.html` handling Hugo's `alert` blockquote
  type for NOTE, TIP and WARNING (other alert types fall back to NOTE styling).
- Each renders as an `<aside>` (or `<div role="note">`) with a visible text label ("Warning"), not color or
  icon alone. Colors: warning tokens in 6.1; NOTE and TIP use accent/chip tokens; all AA.
- Plain blockquotes keep their markup and only get the new colors.
- The 10 or so posts with hand-written `> **Warning**` are not rewritten.
- Document the syntax, commented, in `blog/_template.md`.
- Markdown output keeps the original `> [!WARNING]` text (verify it is untouched).

### 6.7 Optional `quick_fix` frontmatter

- New optional field `quick_fix` (Markdown string). When present, render a "Quick fix" box at the top
  of the article, above the TOC.
- Also emit it in `single.markdown.md` as a short "Quick fix" section, since it is content.
- Never derived from `description` or `.Summary`. Absent field means no box.
- Add it, commented out, to `blog/_template.md` so new posts can use it.

### 6.8 Agents and machine outputs

- `single.markdown.md` uses `.RenderShortcodes`, so the HTML render hook should not affect it.
  The builder must verify this on a real post (diff Markdown output before and after).
- `llms.txt` (`home.llms.txt`) unchanged except nothing new leaks into it.
- Pagefind: `data-pagefind-ignore` on TOC, code header bars, live region.

### 6.9 Accessibility baseline

- `prefers-reduced-motion`: keep the existing global smooth-scroll override; no new animation without it.
- Visible focus on every interactive element using the focus token (3:1 against both background and
  the adjacent color).
- Print: hide copy controls and the sidebar TOC.
- Logo `alt=""` stays (the site name text sits next to it).

## 7. Constraints

- Hugo 0.168.0 (pinned), Pagefind 1.5.2, Node 20, build via `npm run build` in the Cloudflare workflow.
  The Docker build in `pipeline.yml` is retired (owner) and out of scope.
- No new build-time internet fetches. If one becomes necessary, state its tier per the owner's CI rules.
- No em dashes or en dashes in any post prose or frontmatter (repo rule; applies to `_template.md` edits).
- Do not commit or push without the owner asking.

## 8. Calls I made (owner should check)

1. **Gold "M" chip logo** (`static/images/logo.png`, used in `config.toml` `images` and the publisher
   logo in `structured-data.html`): left as is for social and structured data. The bean is the visible
   site logo. Retiring the chip is a separate decision.
2. **Navigation and findability:** no changes beyond the header restyle. Search, categories, and the
   menu stay as they are.
3. **Visual reference:** the chosen mockups are copied to `docs/superpowers/specs/assets/2026-10-19-theme-redesign/`
   (`green-direction.html` option G2, `toc-copy.html` TOC option 1 and copy option A). They are the visual
   reference for details the tables don't cover (lime left border on code blocks, active-nav underline).
   Where a mockup and this doc disagree, this doc wins. Mockup JS (the `execCommand` fallback, the C
   prompt parser) is not a reference.
6. **Fenced code only** gets the header bar and Copy button. Raw HTML `<pre>` (14 files) and indented
   blocks get the code surface colors from CSS but no button.
4. **Contrast check:** a small dependency-free Node script (Node 20 is already in CI) that reads the
   token pairs in 6.1 and exits non-zero on any AA miss. Owner chose to fail CI: add it as a step in
   the Test job of `.github/workflows/cloudflare-workers.yml`, and as `npm run check:contrast`. It reads
   only theme files, so post content can never trip it. No new fetch on the build path.
5. **`.superpowers/`** (brainstorm mockups) gets added to `.gitignore`.

## 9. Left to the builder

- Exact Chroma class list and mapping.
- Single-render vs. dual-render TOC, as long as only one is exposed at a time.
- CSS file organization (new component partials are fine).
- Exact sidebar breakpoint within roughly 68 to 76rem.

## 10. Success criteria

1. Contrast script passes for every pair in 6.1, light and dark.
2. A built page has zero inline `style="color:` from Chroma (`grep -c 'style="color' public/**/index.html` is 0 for code).
3. axe (or Lighthouse accessibility) on home, a list page, the search page, and two long posts:
   no color-contrast or name/role violations.
4. Keyboard-only: reach the TOC, jump to a section, copy a block, and hear the status announced in a
   screen reader.
5. With JS off: TOC links work, code is readable, no Copy button is shown.
6. Markdown output for a sample of posts is byte-identical before and after, except posts that add
   `quick_fix`.
7. Pagefind results for "copy" and "on this page" do not return UI text.
8. `npm run build` with `--panicOnWarning` passes.
9. A test post with `> [!NOTE]`, `> [!TIP]` and `> [!WARNING]` renders three labelled callouts that
   pass AA in both modes, and its Markdown output still contains the original alert syntax.
10. `npm run check:contrast` fails when one token is deliberately set to a failing value, and the
    Test job fails with it.
