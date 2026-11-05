// Guards on the in-cluster publisher job branches (TaskForge supporttools-website-990):
// bot branch pushes run Test but never deploy, and bot-pr.yml stays deleted.
// Text checks on the shipped YAML (no YAML parser in the dependencies).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const cf = readFileSync('.github/workflows/cloudflare-workers.yml', 'utf8');
// Comments stripped, so prose about merging cannot satisfy or trip a check.
const code = (s) => s.split('\n').filter((l) => !/^\s*#/.test(l)).map((l) => l.replace(/\s+#\s.*$/, '')).join('\n');

test('bot-pr.yml is gone: the supporttools-publisher-bot App opens bot PRs itself', () => {
  assert.equal(existsSync('.github/workflows/bot-pr.yml'), false);
});

test('cloudflare-workers.yml: bot/** pushes run Test; Deploy-Production stays main-only', () => {
  assert.match(code(cf), /push:\n {4}branches:\n {6}- main\n {6}- 'bot\/\*\*'\n/);
  const deploy = cf.slice(cf.indexOf('  Deploy-Production:'));
  assert.match(deploy, /\n {4}if: \(github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'\) \|\| github\.event_name == 'schedule'\n/);
});
