import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const result = spawnSync(
  'hugo',
  ['--buildDrafts', '--gc', '--destination', '../.theme-test-public', '--baseURL', 'http://localhost/'],
  { cwd: path.join(root, 'blog'), stdio: 'inherit' },
);

if (result.error) {
  console.error(`hugo failed to start: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
