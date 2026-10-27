#!/usr/bin/env node
// Fails the build when a code block carries inline syntax colors.
//
//   node scripts/check-inline-colors.mjs <publicDir>
//     Exit 1 when any built HTML page has a Hugo highlight block whose markup
//     sets color or background-color inline, 2 when there is nothing to scan.
//
// The site highlights with Chroma classes (noClasses = false) so code follows
// the --syntax-* theme tokens. Inline colors come back if noClasses is turned
// on globally, or per block via a fence or shortcode option, and they ignore
// the theme: Monokai's dark palette on the light code surface measured 1.07:1.
// With noClasses the <pre> loses class=chroma, so blocks are found by Hugo's
// highlight wrapper, which is emitted either way. The built site is minified,
// so attributes may be unquoted.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const HIGHLIGHT_OPEN = /<div\s[^>]*\bclass=(?:"[^"]*\bhighlight\b[^"]*"|'[^']*\bhighlight\b[^']*'|highlight(?=[\s>]))[^>]*>/gi;
const DIV_TAG = /<(\/?)div\b[^>]*>/gi;
const START_TAG = /<[a-z][a-z0-9-]*\b[^>]*>/gi;
const STYLE_ATTR = /\sstyle=(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const COLOR_DECL = /(?:^|;)\s*(?:background-)?color\s*:/i;

// The highlight wrapper and everything inside it, matching nested divs
// (linenos=table output nests one).
function blockAt(html, start) {
  DIV_TAG.lastIndex = start;
  let depth = 0;
  for (let m; (m = DIV_TAG.exec(html));) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, DIV_TAG.lastIndex);
  }
  return html.slice(start);
}

// Only real start tags are read. Code that shows HTML is escaped (&lt;span
// style=...), so its text never forms a tag.
function hasInlineColor(block) {
  for (const [tag] of block.matchAll(START_TAG)) {
    const m = STYLE_ATTR.exec(tag);
    if (m && COLOR_DECL.test(m[1] ?? m[2] ?? m[3])) return true;
  }
  return false;
}

export function inlineColorBlocks(html) {
  let count = 0;
  for (const m of html.matchAll(HIGHLIGHT_OPEN)) {
    if (hasInlineColor(blockAt(html, m.index))) count++;
  }
  return count;
}

function htmlFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.html')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const publicDir = process.argv[2] ?? 'blog/public';
  if (!existsSync(publicDir) || !statSync(publicDir).isDirectory()) {
    console.error(`check-inline-colors: ${publicDir} is not a directory; build the site first`);
    process.exit(2);
  }
  const files = htmlFiles(publicDir);
  if (files.length === 0) {
    console.error(`check-inline-colors: no HTML files under ${publicDir}; build the site first`);
    process.exit(2);
  }
  const bad = [];
  for (const f of files) {
    const n = inlineColorBlocks(readFileSync(f, 'utf8'));
    if (n) bad.push(`${relative(publicDir, f).split('\\').join('/')} (${n} block${n === 1 ? '' : 's'})`);
  }
  if (bad.length) {
    console.error(`${bad.length} page(s) render code with inline colors instead of Chroma classes, which ignores the theme's --syntax-* tokens. Check [markup.highlight] noClasses in blog/config.toml and any noClasses/style option on the code fence or highlight shortcode:`);
    for (const b of bad.slice(0, 20)) console.error(`  ${b}`);
    if (bad.length > 20) console.error(`  ... ${bad.length - 20} more`);
    process.exit(1);
  }
  console.log(`check-inline-colors: no inline syntax colors in ${files.length} HTML file(s)`);
}
