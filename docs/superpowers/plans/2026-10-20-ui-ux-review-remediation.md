# UI/UX Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Address all 9 confirmed findings from the external UI/UX review of support.tools: search readability, taxonomy sprawl, dead training paths, design-guide structure, navigation, homepage task paths, applicability metadata, and related content.

**Architecture:** Three waves. Wave A: small, self-contained fixes (contrast, static-page pager, header overflow, search snippets/URL). Wave B: structural repairs with new lint guardrails (design-guide headings, breadcrumbs, taxonomy normalization pipeline). Wave C: discovery features (homepage hubs, related guides, applicability panel, training paths). Every behavioral change lands with a theme test or CI check so the regression class is caught, not just the instance.

**Tech Stack:** Hugo 0.168.0 extended + Dart Sass 1.105.1, Pagefind 1.5.2 component UI, Node 22 test suite (`npm run test:theme`), `scripts/check-contrast.mjs` CI gate, Cloudflare Workers deploy.

**Spec:** docs/superpowers/specs/2026-10-20-ui-ux-review.pdf (the external review) + docs/superpowers/specs/2026-10-20-ui-ux-review-verification.md (per-finding evidence, file:line, measured ratios). Finding IDs F1-F9 below refer to those documents.

## Global Constraints

- WCAG AA: every new text/background pairing must be at least 4.5:1 (3:1 for focus/boundaries) in BOTH light and dark themes; `npm run check:contrast` must pass.
- No em dashes or en dashes in blog prose or frontmatter (per CLAUDE.md).
- URLs are load-bearing: any merged category, renamed menu item, or removed page keeps old URLs working via Hugo aliases or redirects. `/known-good-designs/` URLs never change.
- Content lives in `blog/`, theme in `blog/themes/m10c/`. Tests in `tests/theme/*.test.mjs`, run via `npm run test:theme` (builds drafts into `.theme-test-public` first).
- Pagefind index rebuild (`npm run build` runs pagefind) required after any indexing-attribute change; verify queries before and after.
- Pagefind component CSS uses triple `:is(*, #\#)` specificity; overrides need the same hack or `!important` (prefer the `--pf-*` variables when one exists).
- The ~600 future-dated queued posts must pass any new content lint; new checks use allow-list + baseline so the queue does not break CI on day one.
- No new live internet fetches on build paths (mirror/cache rule). Pagefind and Hugo are already mirrored/baked.

## Decision Gates (owner)

- **D1 Training paths (F3):** DECIDED 2026-10-20 — back-fill Fleet from existing posts; remove the RKE dir with a redirect to the RKE2 path (RKE1 is EOL).
- **D2 Menu consolidation (F6):** DECIDED 2026-10-20 — consolidate to 5: Search, Topics, Training, Reference Designs, About. Certificates (renamed Certifications) and Publications move onto the About page. Home dropped. Old URLs unchanged.
- **D3 Homepage pagination (F7):** DECIDED 2026-10-20 — de-paginate: home shows latest 8 plus curated sections; new /archive/ page carries the paginated feed; existing /page/N/ URLs redirect.
- **D4 Taxonomy mapping (F2):** The canonical hub set and synonym map are reviewed by the owner at the Task 10/11 gate (draft `category-map.yaml` + dry-run diff report). Bulk rewrite does not run until the owner approves the map.
- **CV link (F9):** owner supplies a CV URL or the sentence is removed (default: remove).

Settled by the planner (my calls): search matches use accent-colored foreground (hue + Pagefind's weight 500 distinguish them; 6.51:1 light / 9.46:1 dark); heading lint ships in baseline mode (fails only on new/changed files, 181 legacy files recorded); related guides become the primary post footer block with chronological Newer/Older kept as secondary on posts only; `--color-mark` is renamed `--color-mark-bg` to make its background intent explicit.

## Review Focus

1. Dark-theme search page: matched terms, excerpt text, and focus rings all at AA on `#131c16` surfaces, not just light mode (Task 1 test covers both themes).
2. A query string with regex/HTML-special characters in `?q=` must not break search init or inject markup (Task 6 test: `?q=<script>alert(1)</script>` renders as text, search still works).
3. The frontmatter rewrite script on a post with BOTH inline `categories: ["A","B"]` and block-list YAML forms, and on TOML frontmatter if any exists, must be byte-stable for everything outside the categories key (Task 11 dry-run diff review).
4. Heading demotion must never edit `#` inside fenced code blocks; design guides are full of bash/yaml fences with comments (Task 7 script is fence-aware; test includes a fixture with `# comment` in a fence).
5. Removing home pagination must not 404 existing `/page/N/` deep links from search engines (Task 13: redirect or stub those URLs if D3 chooses de-pagination).

---

### Task 1: Search match contrast fix + CI pairing (F1)

**Files:**
- Modify: `blog/themes/m10c/assets/css/_extra.scss:10`
- Modify: `blog/themes/m10c/assets/css/_base.scss` (rename token, 3 definitions: lines 25, 74, 114)
- Modify: `scripts/check-contrast.mjs`
- Test: `tests/theme/contrast.test.mjs`

**Interfaces:**
- Produces: `--color-mark-bg` token (renamed from `--color-mark`); `--pf-mark: var(--color-accent)`.

- [ ] **Step 1: Write the failing check.** In `scripts/check-contrast.mjs`, add a rule that parses `_extra.scss` for ALL foreground-role Pagefind mappings (`--pf-mark`, `--pf-text`, `--pf-text-secondary`, `--pf-text-muted`) and fails unless each resolved token paired with `color-surface` meets 4.5:1 in both themes (border/focus roles check 3:1 against surface). This closes the class of blind spot, not just the instance: the checker previously only saw pairs declared in `_base.scss`, never third-party variable mappings. Run `npm run check:contrast`, expect FAIL naming `color-mark` at 1.27:1 light.
- [ ] **Step 2: Fix the token.** `_extra.scss:10` becomes `--pf-mark: var(--color-accent);`. Rename `--color-mark` to `--color-mark-bg` in `_base.scss` (grep confirms `_extra.scss:10` was the only consumer, so nothing else references it after the fix; keep the token for future true-highlight use).
- [ ] **Step 3: Verify.** `npm run check:contrast` passes; `npm run test:theme` passes. Add a `tests/theme/contrast.test.mjs` case asserting `_extra.scss` maps `--pf-mark` to an approved foreground token.
- [ ] **Step 4: Commit** `fix(search): render matched terms in accent foreground, meet AA in both themes`

### Task 2: Suppress pager on static pages + About CV sentence (F9b, F9c)

**Files:**
- Modify: `blog/themes/m10c/layouts/_default/single.html` (pager block, ~lines 88-98)
- Modify: `blog/content/about.md:9`
- Test: `tests/theme/` (new assertions in existing site test)

- [ ] **Step 1: Failing test.** Assert built `about/index.html` contains no `.post-pagination` and no "Older article". Expect FAIL.
- [ ] **Step 2: Gate the pager:** `{{ if and (in (slice "post" "known-good-designs") .Section) (or .PrevInSection .NextInSection) }}`.
- [ ] **Step 3: About CV line:** apply the owner's answer (link or removal; default remove the sentence). No dashes in replacement prose.
- [ ] **Step 4: Verify** `npm run test:theme` green. **Commit** `fix(theme): no chronological pager on static pages; fix About CV sentence`

### Task 3: Header overflow fix at 64-84rem (F6, CSS-only part)

**Files:**
- Modify: `blog/themes/m10c/assets/css/components/_app.scss` (lines ~28-31, 83-108, 244-262)
- Test: `tests/theme/` (static CSS assertion) + manual check at 1024/1100/1280px

- [ ] **Step 1:** Raise the single-row breakpoint from `64rem` to `84rem` so 1024-1343px keeps the stacked two-row layout (nav gets full container width, existing `overflow-x: auto` stays as safety net). Hide `.site-brand-description` (tagline) below `84rem` only if it still collides at 84rem+ (measure first).
- [ ] **Step 2: Verify** with the headless-Chrome measurer pattern from the reflow fix (scratchpad `reflow/measure.mjs` approach): at 1024, 1100, 1280, 1440px assert no element overflow in the header and brand/nav boxes do not intersect.
- [ ] **Step 3:** `npm run test:theme`, `npm run check:contrast` green. **Commit** `fix(theme): keep stacked header below 84rem to stop nav collision`

### Task 4: Search snippet readability (F5a)

**Files:**
- Modify: `blog/themes/m10c/assets/css/_extra.scss`
- Modify: `blog/themes/m10c/layouts/_default/search.html:8` (`excerpt-length` 24 -> 40)

- [ ] **Step 1:** In `.search-interface` add `--pf-result-excerpt-font-size: 0.95rem; --pf-summary-font-size: 0.95rem;` and a 3-line clamp override for `.pf-result-excerpt`/`.pf-heading-excerpt` (`white-space: normal; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;`) using the `:is(*, #\#)` specificity hack.
- [ ] **Step 2:** `excerpt-length="40"` in search.html. Keep `max-sub-results="3"`.
- [ ] **Step 3: Verify:** build + serve `.theme-test-public`, query "rke2", confirm multi-line readable excerpts in both themes. Commit `feat(search): readable multi-line result excerpts`

### Task 5: Search index scope (F5b)

**Files:**
- Modify: `blog/themes/m10c/layouts/_default/baseof.html:147` (move `data-pagefind-body` off `<main>`)
- Modify: `blog/themes/m10c/layouts/_default/single.html` (body attr on `.post-content`, `data-pagefind-meta="title"` on the h1, ignore on breadcrumbs/post-meta/post-footer)
- Test: manual before/after queries (release checks)

- [ ] **Step 1:** Move `data-pagefind-body` to `.post-content` in single.html; add `data-pagefind-meta="title"` to the page h1 and `data-pagefind-meta="date[datetime]"` on the time element. Keep the category filter (baseof.html:25). Pages without `.post-content` (lists, about) must keep a body attr on their main content container or they drop from the index: audit every template that renders through baseof and tag each (list.html content block, training list, known-good-designs list).
- [ ] **Step 2: Verify:** `npm run build`, run the review's release-check queries (`rke2` ~81 results baseline, `CrashLoopBackOff` ~8) and confirm counts stay in the same range, snippets no longer lead with title/date/tag text, and section deep links still appear. About page still findable.
- [ ] **Step 3: Commit** `feat(search): index article bodies, not page chrome`

### Task 6: Persist query in URL (F5c)

**Files:**
- Modify: `blog/themes/m10c/assets/js/enhance.js` (new `initSearchUrl()`)
- Test: `tests/theme/enhance.test.mjs`

**Interfaces:**
- Produces: `?q=<term>` read on load (triggers search), written on input (debounced `history.replaceState`), cleared when the box empties.

- [ ] **Step 1: Failing test:** unit-test the pure helpers (parse q from a URL string, build updated URL) in enhance.test.mjs, matching the existing test style for `pickActive`/`statusText`.
- [ ] **Step 2: Implement:** guard on `.search-interface` presence; on load read `q`, `await customElements.whenDefined('pagefind-input')`, set the input value and dispatch a bubbling `input` event; on input, debounce 300ms and `history.replaceState` the new URL. Escape nothing into HTML (value goes only into the input's `.value` property, never innerHTML).
- [ ] **Step 3: Verify:** test passes; manual: search, reload (query restored), share URL into second tab, Back from an article restores state, `?q=<script>` is inert. **Commit** `feat(search): persist query in URL`

### Task 7: Design-guide heading demotion (F4a)

**Files:**
- Create: `scripts/demote-headings.mjs` (fence- and frontmatter-aware, one-shot, --dry-run)
- Modify: 13 files under `blog/content/known-good-designs/` (8 multi-H1 guides demote H1->H2, H2->H3, H3->H4; 5 single-Overview guides demote `# [Overview]` -> `##`)
- Modify: `blog/themes/m10c/layouts/_default/single.html:75` (H1-strip guard: keep as defense, it emits nothing once content is clean)
- Modify: `blog/config.toml` (pin `[markup.tableOfContents] startLevel = 2, endLevel = 3`)

- [ ] **Step 1:** Write the script: line-based, skip frontmatter and fenced blocks, demote only `^#{1,3} ` outside fences, preserve the `[Text](#anchor)` self-link wrappers (existing fragment URLs and Pagefind sub-results keep working). Check no heading exceeds H4; report if it would.
- [ ] **Step 2:** `--dry-run` diff review, then apply to the 13 files only.
- [ ] **Step 3: Verify:** `hugo --panicOnWarning` build; rke2-custom-vms renders exactly one `<h1>`; its TOC lists Prerequisites, Setting Up RKE2, Importing, Testing and Validation, Considerations, References in order. `npm run test:theme` green.
- [ ] **Step 4: Commit** `fix(content): one H1 per design guide, complete nested TOC`

### Task 8: Section breadcrumb for design guides (F4c)

**Files:**
- Modify: `blog/themes/m10c/layouts/_default/single.html:3-10`
- Test: `tests/theme/`

- [ ] **Step 1: Failing test:** built rke2-custom-vms page's breadcrumb hrefs include `/known-good-designs/` (the section hub), not `/categories/known-good-designs/`.
- [ ] **Step 2:** For pages in section `known-good-designs`, build the trail from `.Ancestors` (section + subsection `_index` titles); keep the category-based crumb for ordinary posts.
- [ ] **Step 3:** Verify + **commit** `fix(theme): design-guide breadcrumbs link the curated hub`

### Task 9: Heading lint, baseline mode (F4d)

**Files:**
- Create: `scripts/check-headings.mjs`, `scripts/heading-baseline.json`
- Modify: `package.json` (`check:headings`), `.github/workflows/cloudflare-workers.yml` (Test job)
- Test: `tests/theme/headings.test.mjs`

- [ ] **Step 1:** Script fails on >1 body H1 or a skipped heading level, for any content file NOT in the baseline; generate the baseline from today's 181 legacy files (`--write-baseline`). A file edited out of violation is removed from the baseline on regen.
- [ ] **Step 2:** Wire `check:headings` into the CI Test job next to `check:contrast`. Known-good-designs files must NOT be in the baseline (Task 7 cleaned them).
- [ ] **Step 3:** Test fixture: a draft content file with two H1s fails; the fixture set passes. **Commit** `ci: heading structure lint with legacy baseline`

### Task 10: Category guardrail (F2, stop the bleeding)

**Files:**
- Create: `scripts/check-categories.mjs`, `blog/data/categories.yaml` (allow-list seeded with ALL current 444 terms so CI is green on day one)
- Modify: `package.json`, CI Test job, `blog/_template.md` (categories comment points at the allow-list)
- Test: `tests/theme/categories.test.mjs`

- [ ] **Step 1:** Script parses frontmatter of all `blog/content/**/*.md` (including future-dated), fails on: category absent from allow-list, name containing `/` or `&` unless explicitly flagged `slug:`-safe, case/hyphen variant of an existing name, >4 categories per post.
- [ ] **Step 2:** Seed allow-list from current data; wire into CI. **Commit** `ci: category allow-list guardrail`

### Task 11: Taxonomy mapping draft + rewrite mechanism (F2) — OWNER GATE

**Files:**
- Create: `blog/data/category-map.yaml` (synonym -> canonical, or -> `tag:` demotion), `scripts/rewrite-categories.mjs` (idempotent, --dry-run with diff report)
- Report: dry-run diff + before/after counts table for owner review

**Interfaces:**
- Consumes: allow-list format from Task 10.
- Produces: approved map; rewritten frontmatter across ~3,010 files in ONE mechanical commit.

- [ ] **Step 1:** Generate the DRAFT map: proposed hubs (Kubernetes, Rancher & RKE2, Linux & Systems, Networking, Security, Observability & SRE, Storage & Databases, Go & Programming, Platform & DevOps, AI & ML) plus the synonym clusters from the verification doc (Go Programming/Golang/Go Development/Go Systems Programming -> Go; slash names AI/ML -> "AI & ML", SSL/TLS -> "TLS & Certificates"; Backup variants; SRE variants). Dropped granular labels become tags, nothing is deleted.
- [ ] **Step 2:** Rewrite script: handles inline `[..]` and block `- ` YAML, dedupes per post, byte-stable outside the categories/tags keys, fence/frontmatter aware.
- [ ] **Step 3: STOP — owner reviews** map + dry-run diff report. Do not apply without approval.
- [ ] **Step 4 (after approval):** apply; shrink `blog/data/categories.yaml` to the canonical set; add Hugo aliases on each canonical category `_index.md` for every merged term URL (verify `/categories/golang/` 301s or alias-redirects to `/categories/go/`); recalc counts render correctly on `/categories/`.
- [ ] **Step 5:** `hugo --panicOnWarning`, `check:categories`, `test:theme` green; spot-check 5 merged URLs. **Commit** (two: `feat(taxonomy): category map + rewrite tooling`, then `content: normalize categories to canonical taxonomy`)

### Task 12: Menu consolidation (F6, per D2)

**Files:**
- Modify: `blog/config.toml:19-66` (menu entries), possibly `blog/content/about.md` (absorb Certificates/Publications links)
- Test: `tests/theme/` nav assertions

- [ ] Blocked on **D2**. If consolidation chosen: primary = Search, Topics (`/categories/`), Training, Reference Designs (`/known-good-designs/`), About; Certificates ("Certifications") and Publications listed on the About page (or footer group); drop Home (brand links home). Pure config/content edits; no hover dropdowns; if a disclosure is wanted use native `<details>/<summary>`. Old URLs unchanged. Verify keyboard tab order, update nav tests, re-run Task 3's width measurements (shorter menu may allow a lower single-row breakpoint; adjust if clean at 72rem). **Commit** `feat(nav): consolidated reader-task menu`

### Task 13: Homepage task paths (F7, per D3)

**Files:**
- Create: `blog/data/home.yaml` (ordered hubs `[{title, summary, url}]` + featured design slugs), `blog/themes/m10c/layouts/index.html` (extract posts-list rendering into a partial shared with list.html)
- Modify: `blog/themes/m10c/assets/css/_extra.scss` / `components/_posts_list.scss`
- Test: `tests/theme/home.test.mjs`

- [ ] **Step 1:** Homepage order: hero; inline search (`<pagefind-input>` + results in the same `.search-interface` wrapper, assets loaded only when the page carries search markup); "Start here" hub cards from `home.yaml` resolved with `site.GetPage` so broken refs fail the build; "Reference designs" strip (3-4 featured); "Latest writing".
- [ ] **Step 2 (per D3):** if de-paginating: latest 8 via `first 8 site.RegularPages`, "Browse all" links a new `/archive/` list that carries the pagination; existing `/page/N/` URLs redirect (Worker/_redirects) or build as stubs with `noindex,follow` + link to archive. If keeping pagination: hubs/featured sections render only on page 1 (`.Paginator.PageNumber eq 1`).
- [ ] **Step 3:** Hub names reuse the Task 11 canonical taxonomy (do not invent a second vocabulary). Contrast + tests green. **Commit** `feat(home): search and curated task paths before the feed`

### Task 14: Training paths (F3, per D1)

**Files:**
- Modify: `blog/content/training/_index.md`, `blog/content/training/fleet/_index.md`, `blog/content/training/rke/_index.md`
- Modify: `blog/themes/m10c/layouts/training/list.html` (+ badge styles in `_extra.scss` if forthcoming-flag chosen)
- Test: `tests/theme/`

- [ ] Blocked on **D1**. Back-fill option: add a "Fleet Resources" curated link list from the ~7 existing Fleet posts (pattern: `training/rancher/_index.md`). Forthcoming option: `status: forthcoming` frontmatter + template badge (AA-checked) + suppressed child list + `build: {list: never}` so Pagefind/sitemap skip it + sorted last on the training index. Remove option: delete dir, drop the bullet, alias/redirect to the nearest surviving path (`rke` -> `rke2`). Also fix the k3s typo file `load-balanacer.md` (rename + alias) and note the networking dir's duplicate lesson pairs (vxlan/kubernetes-vxlan, cni/cni-deep-dive) for a later editorial pass. Acceptance (review): every advertised path offers a lesson, resource, or explicit availability status. **Commit** `content(training): no dead-end training paths`

### Task 15: Related guides block (F9a)

**Files:**
- Modify: `blog/config.toml` (`[related]`: includeNewer=true, threshold 60, toLower, indices tags:80 categories:40)
- Create: `blog/themes/m10c/layouts/partials/related.html`
- Modify: `blog/themes/m10c/layouts/_default/single.html` (above the pager), `components/_post.scss`
- Test: `tests/theme/`

- [ ] "Related guides": `site.RegularPages.Related . | first 4`, card list reusing pager styles; known-good-designs pages relate within their own section first. Chronological Newer/Older stays as a small secondary row on posts (Task 2 already removed it from static pages). Time a full build before/after (2,907 pages; related indices have a build cost; if build time grows >25%, lower threshold or drop the date index). Depends on Task 11 landing first so relatedness uses clean categories. **Commit** `feat(theme): related guides on articles`

### Task 16: Applicability panel (F8)

**Files:**
- Create: `blog/themes/m10c/layouts/partials/applicability.html`
- Modify: `blog/themes/m10c/layouts/_default/single.html`, `components/_post.scss`, `blog/_template.md` (commented fields), `partials/structured-data.html` (`last_validated` -> `dateModified`)
- Modify: 5 pilot guides' frontmatter (values from owner): rancher-rke2-small, rke2-custom-vms, ingress-nginx-controller-on-rke2, cert-manager, metallb
- Test: `tests/theme/` (fixture with fields renders panel; without, absent)

- [ ] Frontmatter schema (all optional): `applies_to:` map (rancher, kubernetes, rke2, os, charts), `last_validated:` date, `scope:` string, `feedback_url:` (site-param default). Panel = `<section aria-labelledby>` + `<dl>` (Tested with / Last validated `<time>` / Scope / Report an issue), rendered only when fields exist; stale badge when `last_validated` older than 12 months. Where validation is historical or unknown the panel states that plainly (review requirement). Owner supplies pilot values; panel mechanics do not block on them (fixture-driven tests). **Commit** `feat(guides): applicability panel`

---

## Task order and dependencies

Wave A (independent, ship first): 1, 2, 3, 4, 5, 6. Wave B: 7 -> 8 -> 9 (lint after content clean), 10 -> 11 (gate). Wave C: 12 (D2), 13 (D3, after 11 for hub names), 14 (D1), 15 (after 11), 16 (anytime).

## Release checks (from the review, run before pushing each wave)

Repeat `rke2` and `CrashLoopBackOff` searches; exercise share/reload and section links; inspect headings and breadcrumb destinations on rke2-custom-vms; review both themes; run the 320/390/768px mobile tasks (menu, search, section nav, code copy, return to results); `npm run check:contrast`, `npm run check:headings`, `npm run check:categories`, `npm run test:theme`, `hugo --panicOnWarning`.
