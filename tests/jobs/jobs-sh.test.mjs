// scripts/jobs/lib.sh: staging card changes, the live-card check, and the bot branch
// + PR flow. Runs against a local bare repo and a fake gh on PATH; no network.
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, copyFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

const LIB = resolve('scripts/jobs/lib.sh');
const URL1 = 'https://cdn.support.tools/posts/a/og-111.jpg';
let root;
let clone;
let bare;
let ghLog;

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv() }).trim();
function gitEnv() {
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  delete env.GITHUB_TOKEN;
  delete env.GH_TOKEN;
  return env;
}

function sh(script, extraEnv = {}) {
  const r = spawnSync('bash', ['-c', `set -euo pipefail; . scripts/jobs/lib.sh; ${script}`], {
    cwd: clone, encoding: 'utf8',
    env: { ...gitEnv(), PATH: `${join(root, 'bin')}:${process.env.PATH}`, FAKE_GH_LOG: ghLog, ...extraEnv },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const post = (slug, images = '') => `---\ntitle: "${slug}"\ndate: 2026-11-01T09:00:00-06:00\n${images}---\n\nbody\n`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jobs-sh-'));
  bare = join(root, 'remote.git');
  clone = join(root, 'website');
  ghLog = join(root, 'gh.log');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  execFileSync('git', ['init', '-q', '-b', 'main', clone]);
  mkdirSync(join(clone, 'scripts/jobs'), { recursive: true });
  mkdirSync(join(clone, 'scripts/og'), { recursive: true });
  mkdirSync(join(clone, 'blog/content/post'), { recursive: true });
  copyFileSync(LIB, join(clone, 'scripts/jobs/lib.sh'));
  writeFileSync(join(clone, 'scripts/og/manifest.json'), '{}\n');
  writeFileSync(join(clone, 'blog/content/post/a.md'), post('a'));
  writeFileSync(join(clone, 'blog/content/post/b.md'), post('b'));
  git(clone, 'add', '-A');
  git(clone, 'commit', '-q', '-m', 'init');
  git(clone, 'remote', 'add', 'origin', bare);
  git(clone, 'push', '-q', 'origin', 'main');
  // Fake gh: logs its argv; `pr list` prints FAKE_GH_PRS; `pr view` finds no PR.
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin/gh'), [
    '#!/usr/bin/env bash',
    'echo "$*" >> "$FAKE_GH_LOG"',
    'case "$1 $2" in',
    '  "pr list") printf "%s" "${FAKE_GH_PRS:-}" ;;',
    '  "pr view") exit 1 ;;',
    'esac',
  ].join('\n'));
  chmodSync(join(root, 'bin/gh'), 0o755);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const day = () => execFileSync('date', ['+%Y%m%d'], { env: { ...process.env, TZ: 'America/Chicago' }, encoding: 'utf8' }).trim();

test('nothing staged: "nothing new", no push, no gh', () => {
  const r = sh('stage_card_changes; publish_changes nightly-cards "t"');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /nothing new/);
  assert.equal(existsSync(ghLog), false);
});

test('card changes go to a bot branch with an auto-merge PR; main is never pushed', () => {
  writeFileSync(join(clone, 'blog/content/post/a.md'), post('a', `images: ["${URL1}"]\n`));
  writeFileSync(join(clone, 'blog/content/post/b.md'), post('b').replace('body', 'hand edit'));
  writeFileSync(join(clone, 'scripts/og/manifest.json'), JSON.stringify({ a: { status: 'live', url: URL1 } }, null, 1));
  const mainBefore = git(bare, 'rev-parse', 'main');
  const r = sh('stage_card_changes; echo "staged=$CARD_POSTS_STAGED skipped=$CARD_POSTS_SKIPPED"; check_live_cards_linked; publish_changes nightly-cards "chore(og): 1 more share cards ($(live_card_count) live)"');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /left unstaged \(other edits\): blog\/content\/post\/b\.md/);
  assert.match(r.out, /staged=1 skipped=1/);
  const branch = `bot/nightly-cards-${day()}`;
  assert.equal(git(bare, 'rev-parse', 'main'), mainBefore);
  assert.equal(git(bare, 'log', '-1', '--format=%s', branch), 'chore(og): 1 more share cards (1 live)');
  assert.deepEqual(git(bare, 'diff', '--name-only', 'main', branch).split('\n').sort(), ['blog/content/post/a.md', 'scripts/og/manifest.json']);
  const gh = readFileSync(ghLog, 'utf8');
  assert.match(gh, new RegExp(`pr view ${branch} -R SupportTools/website`));
  assert.match(gh, new RegExp(`pr create -R SupportTools/website --base main --head ${branch} --title chore\\(og\\)`));
  assert.match(gh, new RegExp(`pr merge ${branch} -R SupportTools/website --auto --squash`));
});

test('a live card the staged post does not link is refused and unstaged', () => {
  writeFileSync(join(clone, 'scripts/og/manifest.json'), JSON.stringify({ a: { status: 'live', url: URL1 } }));
  const r = sh('stage_card_changes; check_live_cards_linked');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /MISMATCH a/);
  assert.equal(git(clone, 'diff', '--cached', '--name-only'), '');
});

test('JOB_DRY_RUN commits locally and pushes nothing', () => {
  writeFileSync(join(clone, 'scripts/og/manifest.json'), '{"a":{"status":"batched"}}\n');
  const r = sh('stage_card_changes; publish_changes nightly-cards "chore(og): state"', { JOB_DRY_RUN: '1' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /dry run: would push bot\/nightly-cards-/);
  assert.equal(git(bare, 'branch', '--list', 'bot/*'), '');
  assert.equal(existsSync(ghLog), false);
});

test('an earlier bot PR still open stops the job; today\'s own branch does not', () => {
  let r = sh('refuse_if_earlier_bot_pr nightly-cards', { FAKE_GH_PRS: 'bot/nightly-cards-20000101\nfeature/x\n' });
  assert.equal(r.code, 1);
  assert.match(r.out, /earlier nightly-cards PR still open \(bot\/nightly-cards-20000101/);
  r = sh('refuse_if_earlier_bot_pr nightly-cards', { FAKE_GH_PRS: `bot/nightly-cards-${day()}\nbot/daily-publish-20000101\n` });
  assert.equal(r.code, 0, r.out);
});

test('require_env names what is missing without printing values; npm never falls back to the public registry', () => {
  let r = sh('require_env FOO_SET FOO_MISSING', { FOO_SET: 'secret-value' });
  assert.equal(r.code, 1);
  assert.match(r.out, /missing environment: FOO_MISSING/);
  assert.doesNotMatch(r.out, /secret-value/);
  r = sh('ensure_node_deps', { NPM_REGISTRY: '' });
  assert.equal(r.code, 1);
  assert.match(r.out, /refusing to install npm dependencies from the public registry/);
});

test('the job scripts refuse to start without their credentials', () => {
  for (const [script, want] of [['cards-nightly.sh', /OG_WORK_DIR OPENAI_API_KEY ANTHROPIC_API_KEY OG_WASABI_ACCESS_KEY_ID/], ['weekly-social.sh', /ANTHROPIC_API_KEY BUFFER_API_KEY/]]) {
    const env = { ...gitEnv() };
    for (const k of ['OG_WORK_DIR', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OG_WASABI_ACCESS_KEY_ID', 'OG_WASABI_SECRET_ACCESS_KEY', 'BUFFER_API_KEY']) delete env[k];
    const r = spawnSync('bash', [resolve('scripts/jobs', script)], { encoding: 'utf8', env });
    assert.equal(r.status, 1, script);
    assert.match(r.stderr, want);
  }
});
