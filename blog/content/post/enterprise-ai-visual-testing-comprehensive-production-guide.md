---
title: "Playwright Visual Regression Testing Without Flakes"
date: 2025-05-25T16:34:42-05:00
lastmod: 2026-10-23
draft: false
tags: ["Playwright", "Visual Regression", "toHaveScreenshot", "Testing", "CI/CD", "Docker", "Applitools", "Percy"]
categories:
- Testing
- "CI & CD"
- "Web Development"
author: "Matthew Mattox - mmattox@support.tools"
description: "Stable Playwright toHaveScreenshot tests: deterministic clock, fonts and data, masks, maxDiffPixelRatio, per-platform baselines, and CI containers."
more_link: "yes"
quick_fix: |
  Generate and compare baselines in the same container image as CI (`mcr.microsoft.com/playwright:v1.64.1-noble`), freeze time with `page.clock.setFixedTime()`, set `timezoneId` and `locale` in `use`, mask dynamic regions with `mask: [locator]`, and use `maxDiffPixelRatio` without an absolute `maxDiffPixels` for full-page shots. Re-bake with `npx playwright test --update-snapshots` inside that image.
---

Visual regression tests catch the bugs functional tests cannot: a CSS change that pushes the checkout button under the footer, a font that failed to load, a dark mode that renders black text on a black background. They also have a reputation for flaking, and most teams that give up on them do so because baselines fail for reasons nobody can see in the diff. Nearly all of that flakiness comes from four sources: time, randomness, fonts and rendering environment. This guide shows how to remove each one with Playwright's built-in `toHaveScreenshot`, then takes an honest look at where AI-assisted visual diffing tools help.

<!--more-->

Everything below was run with `@playwright/test` 1.64.1 in the official `mcr.microsoft.com/playwright:v1.64.1-noble` image, against Chromium and Firefox. The failure messages are copied from those runs.

## How `toHaveScreenshot` works

```ts
await expect(page).toHaveScreenshot('dashboard.png');
```

Playwright takes screenshots until two consecutive ones are identical (so it waits out layout shifts), then compares the result pixel by pixel with the stored baseline. The first run has no baseline, so it writes one and fails; you review it and commit it. Later runs compare against it. On failure, the HTML report shows the expected image, the actual image and a diff, with a slider between them.

By default, `toHaveScreenshot` already disables CSS animations and transitions (`animations: 'disabled'`), hides the text caret (`caret: 'hide'`) and captures at CSS pixel scale (`scale: 'css'`). Infinite animations, like a loading spinner, are reset to their initial state, and finite ones are fast-forwarded to the end. That takes care of the most obvious source of noise; the rest is up to you.

## Make the page deterministic

### Freeze the clock

Anything rendered from `new Date()` changes on every run. Playwright's clock API fixes it before the page loads:

```ts {filename="tests/dashboard.spec.ts"}
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // Freeze Date.now() and new Date() so rendered timestamps never change.
  await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
  // Make Math.random deterministic.
  await page.addInitScript(() => {
    let seed = 42;
    Math.random = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };
  });
});

test('dashboard', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('#title')).toBeVisible();
  await expect(page).toHaveScreenshot('dashboard.png', {
    fullPage: true,
    mask: [page.locator('#ad')],
  });
});
```

`setFixedTime` pins `Date` while letting timers run, which is what you want for a screenshot. Use `page.clock.install()` instead if the page relies on `setTimeout` or `setInterval` and you need to control those too.

A trap observed while testing this: with the clock **not** frozen, a "Last updated" timestamp whose seconds changed between runs still passed, because the changed digits fell below a 1% `maxDiffPixelRatio` budget for that element. A loose tolerance does not just absorb noise; it can hide the exact kind of change you wanted to see. Remove the source of variation instead of widening the threshold.

### Pin timezone, locale and color scheme

The same frozen instant renders differently in `America/Chicago` and `UTC`, and `toLocaleString()` depends on the locale. Set them in the config so every machine agrees, along with color scheme and viewport:

```ts {filename="playwright.config.ts"}
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['html', { open: 'never' }]],
  snapshotPathTemplate: '{testDir}/__screenshots__/{platform}/{projectName}/{testFilePath}/{arg}{ext}',
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.01,
      threshold: 0.2,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
      stylePath: './tests/screenshot.css',
    },
  },
  use: {
    baseURL: 'http://127.0.0.1:4173',
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 } } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'], viewport: { width: 1280, height: 720 } } },
  ],
  webServer: {
    command: 'npx --yes http-server@14.1.1 site -p 4173 -a 127.0.0.1 --silent',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
  },
});
```

With this config and the frozen clock, the page renders `Last updated: 1/15/2026, 10:00:00 AM` on every run. Pinning `colorScheme` matters more than it looks: if one test emulates dark mode and the default is left to the browser, a theme toggle elsewhere in the suite can leak into unrelated screenshots.

### Mask what you cannot control

Ads, maps, avatars from a CDN, third-party widgets and anything driven by live data should be masked rather than "stabilized". `mask` paints a solid box (`#FF00FF` by default, change it with `maskColor`) over each matched locator, so the region is part of the layout comparison but its content is not:

```ts
await expect(page).toHaveScreenshot('dashboard.png', {
  mask: [page.locator('#ad'), page.getByTestId('live-orders-count')],
});
```

For elements you want gone entirely, a screenshot-only stylesheet is cleaner than editing the app. `stylePath` injects CSS only while the screenshot is taken:

```css {filename="tests/screenshot.css"}
/* Applied only while Playwright takes screenshots. */
*, *::before, *::after {
  transition: none !important;
  animation: none !important;
}
[data-testid="live-chat"], .cookie-banner {
  visibility: hidden !important;
}
```

Use `visibility: hidden` rather than `display: none` so the hidden element keeps its space and the rest of the layout does not shift.

### Mock the data

A dashboard that shows today's orders will never match yesterday's baseline. Serve fixed data with `page.route()` or point the app at a seeded test backend:

```ts
await page.route('**/api/orders/summary', (route) =>
  route.fulfill({ json: { open: 12, shipped: 340, revenue: 18250.5 } }),
);
```

Then wait for the content, not for an arbitrary timeout. Asserting on a visible element before the screenshot (as in the test above) avoids baking a baseline of the loading skeleton, which is a surprisingly common way to end up with a test that always passes and checks nothing.

### Wait for fonts

If a web font has not finished loading, text renders in the fallback font and every line of text differs. `await page.evaluate(() => document.fonts.ready)` waits for pending font loads. Self-host fonts in the app or test fixture rather than loading them from a third-party CDN during tests, so a slow or blocked font request cannot change the result.

## Thresholds: `threshold`, `maxDiffPixels`, `maxDiffPixelRatio`

There are two separate knobs, and mixing them up causes most "why does this fail" confusion:

- **`threshold`** (0 to 1, default 0.2) is per pixel: how different two colors must be, in the YIQ color space, before the pixel counts as changed. It absorbs anti-aliasing and tiny color shifts. Lower is stricter.
- **`maxDiffPixels`** and **`maxDiffPixelRatio`** are per image: how many changed pixels are allowed, as an absolute count or as a fraction of all pixels.

For full-page screenshots use a ratio. A flat `maxDiffPixels: 100` is generous on a 300 by 50 button and nothing on a 1280 by 4000 page, where a one-pixel font rendering shift touches thousands of pixels.

Do **not** set both, expecting the larger to win. Playwright enforces each limit independently and fails if either is exceeded. In this test, the element changed by 125 pixels, `maxDiffPixelRatio: 0.5` allowed far more than that, and the assertion still failed because `maxDiffPixels: 10` was also set:

```text
Error: expect(locator).toHaveScreenshot(expected) failed
  125 pixels (ratio 0.01 of all image pixels) are different.
```

The identical test with only `maxDiffPixelRatio: 0.5` passed. Start full-page shots at `maxDiffPixelRatio: 0.01`, raise it only with evidence, and prefer element screenshots (`expect(locator).toHaveScreenshot()`) for components, where a small change is a large fraction of the image and will be caught.

## Baselines per browser and per OS

Font rasterization and anti-aliasing differ between Linux, macOS and Windows, and between Chromium, Firefox and WebKit. A baseline is only valid for the platform and browser that produced it. Playwright's default snapshot names include both (for example `dashboard-chromium-linux.png`). The `snapshotPathTemplate` above organizes them into directories instead:

```text
tests/__screenshots__/linux/chromium/dashboard.spec.ts/dashboard.png
tests/__screenshots__/linux/firefox/dashboard.spec.ts/dashboard.png
```

Decide on **one** platform as the source of truth, which should be the one CI runs on. If a developer on macOS runs the suite locally, it looks for `darwin` baselines, finds none, and writes new ones; those should never be committed. The practical rule: baselines are generated only inside the CI container image.

## Run it in a container, locally and in CI

Microsoft publishes an image per Playwright release with the browsers, their system dependencies and a standard set of fonts installed. Pin it to the exact version in `package.json`; a mismatched browser build is itself a source of pixel differences.

Generate or update baselines locally inside the same image:

```bash
docker run --rm --ipc=host -v "$PWD":/work -w /work \
  mcr.microsoft.com/playwright:v1.64.1-noble \
  sh -c 'npm ci && npx playwright test --update-snapshots'
```

`--ipc=host` is recommended for Chromium, which otherwise can run out of shared memory and crash. `--update-snapshots` takes a mode: `changed` (the default when you pass the flag without a value) rewrites only failing or missing baselines, `missing` only writes baselines that do not exist yet, `all` rewrites everything, and `none` never writes. Review the resulting PNG diff in the pull request like any other change.

In GitHub Actions, run the job in the same image:

```yaml {filename=".github/workflows/visual.yml"}
name: visual-regression

on:
  pull_request:

permissions:
  contents: read

jobs:
  visual:
    runs-on: ubuntu-latest
    container:
      image: mcr.microsoft.com/playwright:v1.64.1-noble
      options: --user 1001
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - run: npm ci
      - run: npx playwright test
      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
        if: failure()
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 7
```

The `container` block, including `options: --user 1001`, follows the example in Playwright's CI documentation. The uploaded HTML report contains expected, actual and diff images for every failure, which is what a reviewer needs to decide between "regression" and "update the baseline". Actions are pinned to commit SHAs for the reasons in [GitHub Actions Secrets: OIDC, Environments, SHA Pins](/post/enterprise-github-actions-security-secret-management-guide-2025/).

When baselines legitimately change, regenerate them **in that same image**, either with the `docker run` command above or a manually triggered workflow that runs `npx playwright test --update-snapshots` and opens a pull request with the new PNGs. Never bake on a laptop and push.

## Reading a failure

A failed comparison falls into one of two shapes:

- **A localized block of red in the diff image**: something in that region actually changed. Either it is a bug, or the change is intended and the baseline needs updating.
- **A faint red outline around all text across the whole page**: rendering drift, almost always a different font, browser build or OS than the one that made the baseline. Do not raise the threshold. Find out why the environment differs (wrong image tag, a local bake, a font that failed to load) and fix that.

## AI-assisted visual diffing: what it actually adds

Commercial tools approach the same problem differently from pixel comparison:

- **Applitools Eyes** compares screenshots with what it calls Visual AI and lets you choose a match level per check (for example strict comparison, or layout-only comparison that ignores text and color changes), plus regions to ignore or compare loosely. It also groups identical changes across many screenshots so one approval can accept them all.
- **Percy** (BrowserStack) renders snapshots in its own cloud browsers, which removes the "baselines from the wrong machine" problem by construction. In October 2025 BrowserStack added a Visual Review Agent that summarizes each detected change and groups similar ones to cut review time.

Where these tools genuinely help:

- **Review at scale.** Grouping the same header change across 400 screenshots into one decision is the biggest practical win when a design system update touches every page.
- **Noise tolerance without a global threshold.** Comparing structure rather than raw pixels tolerates anti-aliasing drift while still flagging a moved or missing element, which is hard to tune with `maxDiffPixelRatio` alone.
- **Managed rendering infrastructure** across many browser and viewport combinations.

Where they do not:

- **They do not fix nondeterminism.** A page that renders a different timestamp, random promo or unloaded font each run still produces noise; the tool just labels it more politely. Everything in the determinism section above still applies.
- **"AI found no meaningful change" is a judgment, not a guarantee.** A layout-only comparison is, by design, blind to a price that changed from 19.99 to 91.99. Use strict comparison for content that must be exact.
- **Cost, data handling and lock-in.** Your screenshots, which can include customer-like data from staging, are uploaded to a third party, and baselines live in their service rather than in your repository.

A reasonable approach: start with Playwright's built-in `toHaveScreenshot`, made deterministic as above, with baselines in git. Move to a hosted tool when the number of screenshots or browser combinations makes reviewing PNG diffs in pull requests the bottleneck, not before.

## FAQ

### Should visual tests run on every pull request?

Yes, if they are fast and stable; otherwise they will be ignored. Keep the visual suite small and focused on key pages and components, run it in parallel, and mark it required only after it has run green on `main` for a while.

### Why does the first run fail?

Because there is no baseline yet. Playwright writes the actual screenshot as the new baseline and reports `A snapshot doesn't exist at ..., writing actual.` Review the image, commit it, and the next run compares against it.

### Full page or element screenshots?

Element screenshots for components and anything you can isolate; they are smaller, faster, and sensitive to small changes. Full-page screenshots for a handful of critical pages, with a ratio-based tolerance and masks for dynamic regions.

### Can I compare across browsers, for example Firefox against a Chromium baseline?

No. Each browser needs its own baseline; cross-browser pixel comparison fails on font rendering alone. Use one project per browser, as in the config above.

## Related guides

- [Cross-Browser Testing with BrowserStack and GitHub Actions](/browserstack-github-actions-automated-testing/)
- [GitHub Actions Secrets: OIDC, Environments, SHA Pins](/post/enterprise-github-actions-security-secret-management-guide-2025/)
- [GitHub Actions Conditional Workflows with Dynamic Inputs](/post/github-actions-conditional-workflows-comprehensive-guide/)
