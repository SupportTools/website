#!/usr/bin/env node
// Fails when Hugo reports duplicate target paths, i.e. two content files
// rendering to the same output file with a nondeterministic winner. The usual
// cause is a content/categories/<dir> whose name differs from Hugo's term path
// for the category (for example "AI & ML" renders at ai-&-ml, not ai--ml).
// Usage: node scripts/check-duplicate-paths.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Known pre-existing collisions. Each entry is a substring of the warning line.
// Remove an entry once the underlying content collision is fixed.
export const ALLOWED = ['/training/rke2/ibm-cloud-provider-rke2/'];

export function findDuplicates(output, allowed = ALLOWED) {
  return output
    .split('\n')
    .filter((l) => l.includes('Duplicate target paths'))
    .filter((l) => !allowed.some((a) => l.includes(a)));
}

function main() {
  const dest = mkdtempSync(join(tmpdir(), 'hugo-paths-'));
  try {
    const r = spawnSync(
      'hugo',
      ['--source', 'blog', '--destination', dest, '--printPathWarnings'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    if (r.error || r.status !== 0) {
      console.error(r.error ? String(r.error) : `${r.stdout}\n${r.stderr}`);
      process.exit(1);
    }
    const bad = findDuplicates(`${r.stdout}\n${r.stderr}`);
    if (bad.length) {
      console.error('Duplicate target paths found:\n' + bad.join('\n'));
      process.exit(1);
    }
    console.log('check-duplicate-paths: OK');
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
