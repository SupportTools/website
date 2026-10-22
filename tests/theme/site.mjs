import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PUBLIC_DIR = path.join(root, '.theme-test-public');

export function readPage(urlPath) {
  if (!fs.existsSync(PUBLIC_DIR)) {
    throw new Error('run npm run test:theme first');
  }
  const rel = urlPath.replace(/^\/+/, '').replace(/\/+$/, '');
  const file = /\.(md|txt|json)$/.test(rel)
    ? path.join(PUBLIC_DIR, rel)
    : path.join(PUBLIC_DIR, rel, 'index.html');
  return fs.readFileSync(file, 'utf8');
}
