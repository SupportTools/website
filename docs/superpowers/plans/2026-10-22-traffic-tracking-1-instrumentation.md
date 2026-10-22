# Traffic Tracking, Part 1: Instrumentation and Bot Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every PostHog event from a support.tools article carries the article's slug, section, category, tags, kind, publish date and word count; readers who finish an article send `article_read`; copy-button use sends `code_copied`; and one shared definition removes the headless-Chrome bot from every PostHog number.

**Architecture:** Hugo renders a JSON data block of post properties on article pages. The inline PostHog snippet in `baseof.html` merges those properties into every event through `before_send`, so the first `$pageview` already has them. `enhance.js` adds the two new events, using pure functions that are unit-tested. The bot filter is one HogQL expression kept in `analytics/bot-filter.hogql` and saved as project 78897's test-account filter. Part 3's exporter reuses the same file.

**Tech Stack:** Hugo 0.168.0 extended, posthog-js (snippet loader, `before_send`), Node 22 `node:test` (`npm run test:theme`), the PostHog MCP connector (project 78897).

**Spec:** `docs/superpowers/specs/2026-10-21-blog-traffic-tracking-design.md`, parts 1 and 1b. Parts 2 to 4 (PostHog dashboard, exporter, scorecard) get their own plans after this one ships, because they need the data this part starts collecting.

## Global Constraints

- No new script files. The additions go in `enhance.js` and a small data block in the template.
- No PII. `person_profiles: 'identified_only'` stays, and readers are never identified.
- Tracking must not slow the page. Add no new network requests and no new third-party script.
- The GTM container `GTM-TF2NG6JW` stays (the owner has not yet confirmed what it contains). Only the dead UA `gtag` goes.
- PostHog data lives in project **78897**. Every query filters `$host = 'support.tools'`.
- Do not use em or en dashes in user-facing copy.
- The read threshold is 75% of the article body plus at least 30 s, and it fires once per page view.

## Review Focus

1. **The reader switches tabs mid-article.** Time spent in a hidden tab must not count toward the 30 s. (Task 3, `visibleMs` test.)
2. **A short article fits on one screen.** It reaches 75% on load, so it must wait for 30 s of visible time and then fire exactly once. (Task 3, `shouldSendRead` tests.)
3. **An ad blocker stops PostHog from loading** (`window.posthog` is undefined). Copy buttons and the TOC must keep working, with no thrown errors. (Task 3, `track` test.)
4. **A post with no categories or tags, or with a quote or `</script>` in a tag.** The data block must still be valid JSON and must not break out of the script tag. (Task 2, fixture plus `JSON.parse` test.)
5. **A real human on Linux Chrome at a different viewport.** The bot filter must not remove them. (Task 4, verification query on the non-bot Linux count.)

---

## File Structure

| File | Responsibility |
|---|---|
| `blog/themes/m10c/layouts/_default/baseof.html` | Remove the UA block. Render the props partial. Add `before_send` to `posthog.init`. |
| `blog/config.toml` | Remove `googleAnalytics`. |
| `blog/themes/m10c/layouts/partials/analytics-props.html` (new) | Emits `<script type="application/json" id="post-analytics">` on article pages, and holds the `post_kind` rule. |
| `blog/themes/m10c/assets/js/enhance.js` | `article_read` and `code_copied`, plus their pure helpers. |
| `blog/content/post/theme-fixture-troubleshooting.md` (new) | Fixture for kind `troubleshooting`, with no categories and a hostile tag. |
| `blog/content/post/theme-fixture-short.md` | Gains `post_kind: incident` (the override fixture). |
| `tests/theme/analytics.test.mjs` (new) | Built-page assertions for the UA removal, the data block and `before_send`. |
| `tests/theme/enhance.test.mjs` | Unit tests for the new pure functions. |
| `analytics/bot-filter.hogql` (new) | The one bot definition, as a HogQL boolean that is true for humans. |
| `analytics/README.md` (new) | Says where the filter is applied and how to re-check the bot signature monthly. |

---

### Task 1: Remove the dead Universal Analytics tag

**Files:**
- Modify: `blog/themes/m10c/layouts/_default/baseof.html:56` (`{{ template "_internal/google_analytics.html" . }}`) and `:61-68` (the `<!-- Google Analytics -->` block)
- Modify: `blog/config.toml:84` (`googleAnalytics = "UA-151436906-1"`)
- Create: `tests/theme/analytics.test.mjs`

**Interfaces:**
- Produces: `tests/theme/analytics.test.mjs`, which Task 2 extends.

- [ ] **Step 1: Write the failing test** in `tests/theme/analytics.test.mjs` (same imports as `related.test.mjs`):

```js
test('no Universal Analytics tag on any page type', () => {
  for (const p of ['theme-fixture', 'about', '']) {
    const html = readPage(p);
    assert.ok(!html.includes('UA-151436906-1'), `${p || 'home'} still has the UA id`);
    assert.ok(!html.includes('googletagmanager.com/gtag/js'), `${p || 'home'} still loads gtag.js`);
  }
});

test('GTM and PostHog are still present', () => {
  const html = readPage('theme-fixture');
  assert.match(html, /GTM-TF2NG6JW/);
  assert.match(html, /posthog\.init\('phc_/);
});
```

- [ ] **Step 2: Run** `npm run test:theme`. Expected: the first test FAILS (UA id present).
- [ ] **Step 3: Delete** the two template lines or blocks and the config key listed above.
- [ ] **Step 4: Run** `npm run test:theme`. Expected: all tests PASS.
- [ ] **Step 5: Commit** with the message `chore(theme): drop the dead Universal Analytics tag (UA stopped processing in 2023)`.

---

### Task 2: Post properties on every PostHog event

**Files:**
- Create: `blog/themes/m10c/layouts/partials/analytics-props.html`
- Modify: `blog/themes/m10c/layouts/_default/baseof.html`. Render `{{ partial "analytics-props.html" . }}` just before `<!-- PostHog Analytics -->`, and add `before_send` to `posthog.init`.
- Create: `blog/content/post/theme-fixture-troubleshooting.md`
- Modify: `blog/content/post/theme-fixture-short.md` (add `post_kind: incident`)
- Test: `tests/theme/analytics.test.mjs`

**Interfaces:**
- Produces: these event property names, which the exporter and dashboard plans query. `post_slug`, `post_section`, `post_category`, `post_tags`, `post_kind`, `post_published`, `post_words`.
- Produces: `post_kind` ∈ `troubleshooting | incident | guide | reference`. Non-article pages have no `post_kind`, and later plans bucket them as `page`.

**The partial.** It renders only when `.IsPage` and `.Section` is one of `post`, `known-good-designs` or `training`. It emits `<script type="application/json" id="post-analytics">{{ $props | jsonify | safeJS }}</script>`. `jsonify` escapes `<` as `<`, which is what makes a `</script>` in a tag safe. The values:

| Key | Value |
|---|---|
| `post_slug` | `.RelPermalink` with the leading and trailing `/` trimmed (`theme-fixture`, `known-good-designs/loadbalancers/ingress-nginx-controller-on-eks`) |
| `post_section` | `.Section` |
| `post_category` | `index .Params.categories 0 \| urlize`, or `""` when there are no categories |
| `post_tags` | the first 5 of `.Params.tags`, unchanged; `[]` when there are none |
| `post_kind` | the rule below |
| `post_published` | `.Date.Format "2006-01-02"` |
| `post_words` | `.WordCount` |

**The `post_kind` rule** (builder's call per the spec; the first match wins):
1. `.Params.post_kind`, when set. The field is named `post_kind`, not `kind`, because `kind` would be confused with Hugo's own page `.Kind`.
2. `reference` when `.Section` is `known-good-designs` or `training`.
3. `troubleshooting` when the lowercase title or slug matches `fix|troubleshoot|error|not working|failed|failing|stuck|crashloop|denied|refused|timeout`, or when any category is `Troubleshooting`.
4. `guide` otherwise.

**The `before_send` addition** to the existing `posthog.init` options. Read the data block once, and merge it into each event without overwriting keys PostHog already set:

```js
before_send: (function () {
  var el = document.getElementById('post-analytics'), props = {};
  try { props = el ? JSON.parse(el.textContent) : {}; } catch (e) { props = {}; }
  return function (ev) {
    if (ev && ev.properties) for (var k in props) if (!(k in ev.properties)) ev.properties[k] = props[k];
    return ev;
  };
}())
```

**The fixture** `theme-fixture-troubleshooting.md`:
- Copy the frontmatter of `theme-fixture.md`.
- Set `url: "/theme-fixture-error-fix/"` and `title: "Theme Fixture Error Fix"`.
- Remove `categories` and `quick_fix`.
- Set `tags: ["Theme", "a\"b</script>c"]`.
- Keep `draft: true` and `noindex: true`.

- [ ] **Step 1: Write the failing tests** in `analytics.test.mjs`:

```js
function props(urlPath) {
  const m = readPage(urlPath).match(/<script type="application\/json" id="post-analytics">([\s\S]*?)<\/script>/);
  return m ? JSON.parse(m[1]) : null;
}

test('article pages carry the post properties', () => {
  assert.deepEqual(props('theme-fixture'), {
    post_slug: 'theme-fixture', post_section: 'post', post_category: 'theme',
    post_tags: ['Theme'], post_kind: 'guide', post_published: '2020-01-01',
    post_words: props('theme-fixture').post_words,
  });
  assert.ok(props('theme-fixture').post_words > 50);
});

test('post_kind: frontmatter override, troubleshooting signal, reference section', () => {
  assert.equal(props('theme-fixture-short').post_kind, 'incident');
  assert.equal(props('theme-fixture-error-fix').post_kind, 'troubleshooting');
  assert.equal(props('known-good-designs/loadbalancers/ingress-nginx-controller-on-eks').post_kind, 'reference');
});

test('no categories and a hostile tag still give valid, contained JSON', () => {
  const p = props('theme-fixture-error-fix');
  assert.equal(p.post_category, '');
  assert.deepEqual(p.post_tags, ['Theme', 'a"b</script>c']);
  const raw = readPage('theme-fixture-error-fix').split('id="post-analytics">')[1].split('</script>')[0];
  assert.ok(!raw.includes('</script'), 'tag text did not close the script element');
});

test('non-article pages have no data block', () => {
  assert.equal(props('about'), null);
  assert.equal(props(''), null);
});

test('PostHog init merges the block through before_send', () => {
  assert.match(readPage('theme-fixture'), /before_send:[\s\S]*post-analytics/);
});
```

- [ ] **Step 2: Run** `npm run test:theme`. Expected: the new tests FAIL (`props` returns null).
- [ ] **Step 3: Implement** the partial, the fixture, the override line and `before_send` as specified above.
- [ ] **Step 4: Run** `npm run test:theme`. Expected: all tests PASS. Also run `npm run check:paths` and `npm run check:categories`, which must still pass with the new fixture.
- [ ] **Step 5: Check** that the HTML of `.theme-test-public/theme-fixture/index.html` grew by less than 1 KB compared with `git stash` of the change (the "no slower page" constraint).
- [ ] **Step 6: Commit** with the message `feat(theme): tag PostHog events with post slug, topic, kind and length`.

---

### Task 3: `article_read` and `code_copied` events

**Files:**
- Modify: `blog/themes/m10c/assets/js/enhance.js`
- Test: `tests/theme/enhance.test.mjs`

**Interfaces:**
- Produces: these exported pure functions, each with tests.
  - `readRatio(scrollY: number, viewportH: number, top: number, height: number) -> number`. The share of `.post-content` whose bottom edge has scrolled into view, clamped to [0, 1]. It returns 1 when `height <= 0`. `top` is the element's document offset.
  - `visibleMs(prevMs: number, sinceMs: number, nowMs: number, hidden: boolean) -> number`. The accumulated visible time; it adds `nowMs - sinceMs` only when `hidden` is false.
  - `shouldSendRead(ratio: number, visibleMs: number, sent: boolean) -> boolean`. True when `ratio >= 0.75 && visibleMs >= 30000 && !sent`.
  - `track(event: string, props?: object) -> boolean`. Calls `window.posthog.capture` when it is a function, and returns whether it did. It never throws.
- Produces: event names `article_read` (props `{read_ratio, visible_seconds}`) and `code_copied` (no extra props; `before_send` adds `post_slug`).

- [ ] **Step 1: Write the failing tests** in `enhance.test.mjs` (add the four names to the import):

```js
test('readRatio measures how far into the article body the reader has seen', () => {
  assert.equal(readRatio(0, 800, 200, 2400), 0.25);      // (0+800-200)/2400
  assert.equal(readRatio(5000, 800, 200, 2400), 1);       // clamped
  assert.equal(readRatio(0, 800, 1200, 2400), 0);         // body below the fold
  assert.equal(readRatio(0, 800, 0, 0), 1);               // empty body
});

test('visibleMs only counts time while the tab is visible', () => {
  assert.equal(visibleMs(1000, 0, 5000, false), 6000);
  assert.equal(visibleMs(1000, 0, 5000, true), 1000);
});

test('shouldSendRead needs 75% and 30 s of visible time, once', () => {
  assert.equal(shouldSendRead(0.75, 30000, false), true);
  assert.equal(shouldSendRead(0.74, 60000, false), false);
  assert.equal(shouldSendRead(1, 29999, false), false);   // short post fully on screen
  assert.equal(shouldSendRead(1, 30000, true), false);    // already sent
});

test('track is a no-op without PostHog and calls capture when present', () => {
  delete globalThis.window;
  assert.equal(track('code_copied'), false);
  const calls = [];
  globalThis.window = { posthog: { capture: (...a) => calls.push(a) } };
  assert.equal(track('article_read', { read_ratio: 1 }), true);
  assert.deepEqual(calls, [['article_read', { read_ratio: 1 }]]);
  delete globalThis.window;
});
```

- [ ] **Step 2: Run** `npm run test:theme`. Expected: these FAIL (the functions are not exported).
- [ ] **Step 3: Implement** the four functions and their wiring:
  - **`enhanceReadTracking()`**, called from `init()`. It returns early when there is no `.post-content`.
  - It keeps `{ acc, since, sent, maxRatio }`.
  - On `visibilitychange` it updates `acc` with `visibleMs`.
  - On a passive `scroll` listener, throttled with `requestAnimationFrame`, it updates `maxRatio`.
  - A 5 s `setInterval` checks `shouldSendRead(maxRatio, visibleMs(acc, since, Date.now(), document.hidden), sent)`. On true it calls `track('article_read', { read_ratio: round2(maxRatio), visible_seconds })`, sets `sent`, and clears the interval.
  - It also runs one check at load, so a fully visible short post only needs the timer.
  - In `copyBlock`, call `track('code_copied')` when `ok` is true.
- [ ] **Step 4: Run** `npm run test:theme`. Expected: all tests PASS.
- [ ] **Step 5: Manually check** with `npm run serve`. Open `/theme-fixture/` with the DevTools console:
  - `window.posthog.capture = (...a) => console.log(a)` logs `code_copied` on Copy.
  - It logs `article_read` after you scroll to the end and wait 30 s.
  - With the tab hidden for 30 s, then shown, nothing fires until 30 s of visible time.
- [ ] **Step 6: Commit** with the message `feat(theme): article_read and code_copied events`.

---

### Task 4: One shared bot filter in PostHog

**Files:**
- Create: `analytics/bot-filter.hogql`
- Create: `analytics/README.md`
- Modify: `docs/superpowers/specs/2026-10-21-blog-traffic-tracking-design.md` (in 1b, replace "cohort-free event filter" with the file path and say how it is applied)

**Interfaces:**
- Produces: `analytics/bot-filter.hogql`, a single HogQL boolean that is **true for human events**. The part 3 exporter embeds this file verbatim, which is why it lives in its own directory inside the Go module root.

**The expression.** Confirm it against the data in Step 1 before saving:

```sql
NOT (
  properties.$os = 'Linux'
  AND properties.$browser = 'Chrome'
  AND toInt(splitByChar('.', toString(properties.$browser_version))[1]) = 154
  AND toInt(properties.$viewport_width) BETWEEN 1890 AND 1920
  AND properties.$referring_domain = 'www.google.com'
)
```

- [ ] **Step 1: Confirm the signature** with the PostHog connector (`execute-sql`, project 78897). Compare the last 30 days of `$pageview` where `$host = 'support.tools'`, grouped by whether the expression is true. Expected:
  - About 3,900 pageviews are removed (the spec measured 3,893 on 2026-10-21).
  - Linux + Chrome pageviews that are **not** removed number more than 0. These are the human Linux readers.
  - If more than 2% of the removed pageviews have more than one pageview per `distinct_id`, the signature is catching humans. Stop and narrow it.
- [ ] **Step 2: Write** `analytics/bot-filter.hogql` (the expression only, no comments, so the exporter can embed it as-is). Write `analytics/README.md` with 10 lines or fewer:
  - What the filter removes.
  - That it is project 78897's test-account filter.
  - That every insight must have "Filter out internal and test users" on.
  - How to re-check monthly: rerun the Step 1 query and watch `blog_bot_pageviews` once part 3 ships.
- [ ] **Step 3: Apply it** as the project's test-account filter through the connector (project update, `test_account_filters`), keeping any existing entries:

```json
[
  {"type": "hogql", "key": "<contents of analytics/bot-filter.hogql>"},
  {"type": "event", "key": "$host", "operator": "exact", "value": ["support.tools"]}
]
```

  Also set `test_account_filters_default_checked: true`.
- [ ] **Step 4: Verify** with a typed trends query (`$pageview`, last 30 days, weekly), run once with `filterTestAccounts: false` and once with `true`. Expected: the difference matches Step 1's removed count within 1%, and the filtered series has no Aug 2 or Sep 20 spike.
- [ ] **Step 5: Commit** `analytics/` and the spec edit with the message `feat(analytics): one shared PostHog bot filter`.

---

### Task 5: Ship and confirm live data

- [ ] **Step 1:** Push `main` (the owner approved pushing this work on 2026-10-22). Wait for the "Deploy to Cloudflare Workers" run on the pushed SHA to finish with success:

```bash
curl -s "https://api.github.com/repos/SupportTools/website/actions/runs?per_page=5"
```

- [ ] **Step 2:** Check that `curl -s https://support.tools/<a recent post>/ | grep -c 'id="post-analytics"'` prints `1`, and that the same check on `https://support.tools/about/` prints `0`.
- [ ] **Step 3:** Open a live post in a browser, scroll to the end, wait 30 s, and press a Copy button. Within 5 minutes, `execute-sql` on project 78897 must return these from the last hour:
  - A `$pageview` with non-null `post_slug`, `post_kind` and `post_category`.
  - One `article_read`.
  - One `code_copied`.
- [ ] **Step 4:** Update `memory/blog-analytics.md`: instrumentation is live, give the date, and note that the property names are the contract for parts 2 to 4.
