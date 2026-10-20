#!/usr/bin/env node
// Rewrites post categories according to blog/data/category-map.yaml.
// Merged labels are replaced by their canonical name; demoted labels leave the
// category list and become tags. Line-level edits only, idempotent.
// Usage: node scripts/rewrite-categories.mjs [--dry-run] [--report <file>] [--map <file>] [--content <dir>]
//   --dry-run  write nothing but the optional report
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseMap, validateMap, rewriteText } from './lib/category-rewrite.mjs';

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i === -1 ? def : process.argv[i + 1];
}

function tally(items) {
  const m = new Map();
  for (const x of items) m.set(x, (m.get(x) || 0) + 1);
  return m;
}

// Small unified diff for one post: line-level LCS over the region between the
// common prefix and suffix (frontmatter edits only), two lines of context.
function unifiedDiff(path, before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  const x = a.slice(s, a.length - e);
  const y = b.slice(s, b.length - e);
  const lcs = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const body = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) body.push(` ${x[i++]}`), j++;
    else if (i < x.length && (j === y.length || lcs[i + 1][j] >= lcs[i][j + 1])) body.push(`-${x[i++]}`);
    else body.push(`+${y[j++]}`);
  }
  const lo = Math.max(0, s - 2);
  const ctxAfter = a.slice(a.length - e, a.length - e + 2);
  const lines = [...a.slice(lo, s).map((l) => ` ${l}`), ...body, ...ctxAfter.map((l) => ` ${l}`)];
  const oldN = lines.filter((l) => l[0] !== '+').length;
  const newN = lines.filter((l) => l[0] !== '-').length;
  return [`--- a/${path}`, `+++ b/${path}`, `@@ -${lo + 1},${oldN} +${lo + 1},${newN} @@`, ...lines].join('\n');
}

export function runRewrite({ map, files }) {
  const results = files.map(([path, text]) => ({ path, original: text, ...rewriteText(text, map) }));
  const before = tally(results.flatMap((r) => [...new Set(r.before)]));
  const after = tally(results.flatMap((r) => [...new Set(r.after)]));
  return { results, before, after };
}

function buildReport({ map, results, before, after }) {
  const L = [];
  const changed = results.filter((r) => r.changed);
  const problems = results.filter((r) => r.problems.length);
  const mergedAway = [...map.merge.keys()].filter((k) => before.has(k));
  const demoted = [...map.demote.keys()].filter((k) => before.has(k));
  const fallbackUsed = results.filter((r) => r.usedFallback);

  L.push('# Task 11: category map dry-run report', '');
  L.push('Nothing was modified. This report is what the apply step would do with `blog/data/category-map.yaml`.', '');
  L.push('## Summary', '');
  L.push(`- Category terms: **${before.size} before, ${after.size} after**`);
  L.push(`- Terms merged into another category: ${mergedAway.length}`);
  L.push(`- Terms demoted to tags: ${demoted.length}`);
  L.push(`- Posts scanned: ${results.length}; posts that would change: **${changed.length}**`);
  L.push(`- Posts that would get a fallback category (every category was demoted): ${fallbackUsed.length}`);
  L.push(`- Posts that would be left with no category (must be 0 before apply): ${problems.length}`, '');
  for (const p of problems) L.push(`  - ${p.path}: ${p.problems.join('; ')}`);

  // 1. canonical list grouped by hub
  L.push('## Judgment calls to check first', '');
  L.push('- `CI/CD` becomes `CI & CD`: a slash in a category name creates a nested URL (`/categories/ci/cd/`) and a phantom `ci` term, so slash names are banned.');
  L.push('- `Database` (39 posts) merges into the plural `Databases` (30 posts), the name the verification report grouped under.');
  L.push('- `Enterprise` (25 posts) and `Technology`, `Tech`, `Misc` are vague labels, so they become tags; posts with nothing else fall back to `Infrastructure`.');
  L.push('- `Systems` (12 posts) and `Systems Engineering` fold into `Systems Programming`, and `Linux Administration` into `System Administration`.');
  L.push('- Product names with a single post (Cilium, Velero, cert-manager, Falco and similar) become tags on the post. Categories with two or more posts are left alone unless they are an exact variant.', '');
  L.push('## 1. Proposed canonical categories, grouped by hub', '');
  L.push('Counts are articles carrying the category. "Before" is the exact-case term today, "after" is once the map is applied. Edit `hubs:` in the map to move a category between hubs.', '');
  const hubOf = new Map();
  for (const [h, cats] of map.hubs) for (const c of cats) hubOf.set(c, h);
  const canon = [...after.keys()];
  const groups = new Map([...map.hubs.keys()].map((h) => [h, []]));
  const unassigned = [];
  for (const c of canon) (hubOf.has(c) ? groups.get(hubOf.get(c)) : unassigned).push(c);
  const row = (c) => `| ${c} | ${before.get(c) || 0} | ${after.get(c)} |`;
  const sorted = (cs) => cs.sort((x, y) => after.get(y) - after.get(x) || x.localeCompare(y));
  for (const [h, cs] of groups) {
    if (!cs.length) continue;
    L.push(`### ${h} (${cs.length} categories, ${cs.reduce((n, c) => n + after.get(c), 0)} category assignments)`, '', '| Category | Before | After |', '|---|---:|---:|', ...sorted(cs).map(row), '');
  }
  const orphanHubMembers = [...hubOf.keys()].filter((c) => !after.has(c));
  if (orphanHubMembers.length) L.push(`Warning: hub members that are not final categories: ${orphanHubMembers.join(', ')}`, '');
  if (unassigned.length) L.push(`### No hub assigned (${unassigned.length})`, '', '| Category | Before | After |', '|---|---:|---:|', ...sorted(unassigned).map(row), '');

  // 2. top merges
  const pairs = new Map();
  for (const r of results) for (const c of new Set(r.before)) if (map.merge.has(c)) pairs.set(`${c}\t${map.merge.get(c)}`, (pairs.get(`${c}\t${map.merge.get(c)}`) || 0) + 1);
  L.push('## 2. Top 30 merges by article count', '', '| Source | Target | Articles |', '|---|---|---:|');
  for (const [k, n] of [...pairs].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 30)) {
    const [s, t] = k.split('\t');
    L.push(`| ${s} | ${t} | ${n} |`);
  }
  L.push('');

  // 3. demotions
  const dem = [...map.demote].filter(([k]) => before.has(k)).sort((a, b) => before.get(b[0]) - before.get(a[0]) || a[0].localeCompare(b[0]));
  const examples = [...dem.slice(0, 10), ...dem.slice(10).filter((_, i, arr) => i % Math.max(1, Math.floor(arr.length / 10)) === 0).slice(0, 10)];
  L.push('## 3. Demotions to tags', '');
  L.push(`${demoted.length} terms are removed from \`categories\` and kept as tags on the posts that had them (${dem.reduce((n, [k]) => n + before.get(k), 0)} post-term pairs). Nothing is deleted. Examples (largest first, then a spread):`, '');
  L.push('| Demoted label | Articles | Fallback category if the post has nothing else |', '|---|---:|---|');
  for (const [k, f] of examples) L.push(`| ${k} | ${before.get(k)} | ${f ?? 'none'} |`);
  L.push('');

  // 4. files touched
  L.push('## 4. Files touched', '', `**${changed.length}** of ${results.length} posts change (${results.filter((r) => r.changed && r.tags.length).length} also gain tags).`, '');

  // 5. sample diffs
  const picks = [];
  const used = new Set();
  const want = [
    ['inline list, merge only', (r) => r.changed && !r.tags.length && /^categories:\s*\[/m.test(r.text)],
    ['block list, no new tags needed', (r) => r.changed && !r.tags.length && /^categories:\s*$/m.test(r.text)],
    ['demote appended to an existing tags list', (r) => r.changed && r.tags.length && /^tags:\s*\[/m.test(r.text)],
    ['several categories collapse into one', (r) => r.changed && r.before.length >= 3 && r.after.length <= r.before.length - 2],
    ['fallback category used', (r) => r.usedFallback],
  ];
  for (const [label, test] of want) {
    const r = results.find((x) => !used.has(x.path) && test(x));
    if (r) { used.add(r.path); picks.push([label, r]); }
  }
  L.push('## 5. Sample diffs', '');
  for (const [label, r] of picks) L.push(`### ${label}`, '', '```diff', unifiedDiff(r.path, r.original, r.text), '```', '');
  return L.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dry = process.argv.includes('--dry-run');
  const mapPath = arg('--map', 'blog/data/category-map.yaml');
  const contentDir = arg('--content', 'blog/content');
  const reportPath = arg('--report', null);
  const map = parseMap(readFileSync(mapPath, 'utf8'));
  const mapErrors = validateMap(map);
  if (mapErrors.length) {
    console.error(`Invalid map ${mapPath}:\n  ${mapErrors.join('\n  ')}`);
    process.exit(1);
  }
  const files = walk(contentDir).sort().map((p) => [relative('.', p).split('\\').join('/'), readFileSync(p, 'utf8')]);
  const run = runRewrite({ map, files });
  const changed = run.results.filter((r) => r.changed);
  const problems = run.results.filter((r) => r.problems.length);
  if (reportPath) {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, buildReport({ map, ...run }) + '\n');
    console.log(`Wrote report to ${reportPath}`);
  }
  console.log(`${run.before.size} -> ${run.after.size} category terms; ${changed.length} of ${files.length} posts ${dry ? 'would change' : 'changed'}`);
  if (problems.length) {
    for (const p of problems) console.error(`  ${p.path}: ${p.problems.join('; ')}`);
    console.error(`${problems.length} posts cannot be rewritten; fix the map (add a demote fallback) first`);
    if (!dry) process.exit(1);
  }
  if (!dry) for (const r of changed) writeFileSync(r.path, r.text);
}
