import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inlineColorBlocks } from '../../scripts/check-inline-colors.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'scripts/check-inline-colors.mjs');

// What Chroma emits with the site config (noClasses = false), unminified and minified.
const CLASSED = '<div class="highlight"><pre tabindex="0" class="chroma"><code class="language-sh" data-lang="sh"><span class="line"><span class="cl"><span class="nb">echo</span> hi</span></span></code></pre></div>';
const CLASSED_MIN = '<div class=highlight><pre tabindex=0 class=chroma><code class=language-sh data-lang=sh><span class=line><span class=cl><span class=nb>echo</span> hi</span></span></code></pre></div>';
// What Chroma emits with noClasses = true: inline colors and no chroma class.
const INLINE = '<div class="highlight"><pre tabindex="0" style="color:#f8f8f2;background-color:#272822;-moz-tab-size:4;-o-tab-size:4;tab-size:4;"><code class="language-sh" data-lang="sh"><span style="display:flex;"><span style="color:#f8f8f2">echo</span> hi</span></code></pre></div>';
const INLINE_MIN = '<div class=highlight><pre tabindex=0 style=color:#f8f8f2;background-color:#272822><code><span style=display:flex><span style=color:#f8f8f2>echo</span> hi</span></code></pre></div>';

test('classed Chroma output passes, quoted or minified', () => {
  assert.equal(inlineColorBlocks(CLASSED), 0);
  assert.equal(inlineColorBlocks(CLASSED_MIN), 0);
});

test('inline-styled Chroma output is counted per highlight block, quoted or minified', () => {
  assert.equal(inlineColorBlocks(INLINE), 1);
  assert.equal(inlineColorBlocks(INLINE_MIN), 1);
  assert.equal(inlineColorBlocks(`${CLASSED}<p>x</p>${INLINE}${INLINE_MIN}`), 2);
});

test('linenos=table output is checked inside the highlight wrapper', () => {
  const table = '<div class="highlight"><div style="color:#f8f8f2;background-color:#272822;"><table style="border-spacing:0;padding:0;margin:0;border:0;"><tr><td><pre><code><span style="color:#7f7f7f">1</span></code></pre></td><td><pre><code>x</code></pre></td></tr></table></div></div>';
  assert.equal(inlineColorBlocks(table), 1);
});

test('inline colors outside a highlight block are ignored', () => {
  assert.equal(inlineColorBlocks('<p><span style="color:#c00">warning</span></p><div class=callout style="background-color:#fff">x</div>'), 0);
});

// A post that documents HTML or CSS shows style="color:..." as escaped code
// text. That is content, not markup, and must not trip the check.
test('escaped style attributes in code text pass, quoted or minified', () => {
  const quoted = '<div class="highlight"><pre tabindex="0" class="chroma"><code><span class="line"><span class="cl"><span class="sb">  &lt;span style=&#34;color: #888;&#34;&gt;Confidential&lt;/span&gt;</span></span></span></code></pre></div>';
  const minified = '<div class=highlight><pre tabindex=0 class=chroma><code><span class=line><span class=cl>&lt;p style=&#34;color:#c00&#34;&gt; and .x { background-color: #fff; } style=color:#f00</span></span></code></pre></div>';
  assert.equal(inlineColorBlocks(quoted), 0);
  assert.equal(inlineColorBlocks(minified), 0);
});

test('non-color inline styles inside a highlight block pass', () => {
  assert.equal(inlineColorBlocks('<div class="highlight"><pre class="chroma"><code><span style="display:flex;">x</span></code></pre></div>'), 0);
});

function site(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inline-colors-'));
  for (const [rel, html] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), html);
  }
  return dir;
}

test('CLI exits 0 on a clean build and names offending pages otherwise', () => {
  const clean = site({ 'index.html': CLASSED, 'a/index.html': CLASSED_MIN });
  const ok = spawnSync('node', [SCRIPT, clean], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /2 HTML file/);

  const dirty = site({ 'index.html': CLASSED, 'bad-post/index.html': INLINE, 'other/index.html': INLINE_MIN });
  const bad = spawnSync('node', [SCRIPT, dirty], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /bad-post\/index\.html/);
  assert.match(bad.stderr, /other\/index\.html/);
});

test('CLI fails closed on a missing or empty build directory', () => {
  assert.equal(spawnSync('node', [SCRIPT, path.join(os.tmpdir(), 'no-such-public-dir')], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync('node', [SCRIPT, site({})], { encoding: 'utf8' }).status, 2);
});
