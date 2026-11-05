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
  delete env.WEBSITE_GIT_MODE;
  return env;
}

function sh(script, extraEnv = {}) {
  const r = spawnSync('bash', ['-c', `set -euo pipefail; . scripts/jobs/lib.sh; ${script}`], {
    cwd: clone, encoding: 'utf8',
    // Full App mode (GH_TOKEN set, WEBSITE_GIT_MODE unset) unless a test passes a
    // push-only WEBSITE_GIT_MODE (see PUSH_ONLY below).
    env: { ...gitEnv(), PATH: `${join(root, 'bin')}:${process.env.PATH}`, FAKE_GH_LOG: ghLog, GH_TOKEN: 'fake-app-token', ...extraEnv },
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
  // Fake gh: logs its argv; `pr list` prints FAKE_GH_PRS (or fails with
  // FAKE_GH_LIST_FAIL); `pr view` finds no PR; `pr merge` fails with FAKE_GH_MERGE_FAIL.
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin/gh'), [
    '#!/usr/bin/env bash',
    'echo "$*" >> "$FAKE_GH_LOG"',
    'case "$1 $2" in',
    '  "pr list") [ -z "${FAKE_GH_LIST_FAIL:-}" ] || { echo "HTTP 401: Bad credentials" >&2; exit 1; }; printf "%s" "${FAKE_GH_PRS:-}" ;;',
    '  "pr view") exit 1 ;;',
    '  "pr merge") [ -z "${FAKE_GH_MERGE_FAIL:-}" ] || { echo "Auto merge is not allowed for this repository" >&2; exit 1; } ;;',
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

test('a gh failure listing PRs stops the job instead of reading as "no open PR"', () => {
  const r = sh('refuse_if_earlier_bot_pr nightly-cards', { FAKE_GH_LIST_FAIL: '1' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /cannot list open PRs; refusing to run/);
});

test('an added list item or blank line counts as another edit; only the images line is staged', () => {
  writeFileSync(join(clone, 'blog/content/post/a.md'), post('a', `images: ["${URL1}"]\n- new\n`));
  writeFileSync(join(clone, 'blog/content/post/b.md'), post('b', `images: ["${URL1}"]\n`).replace('body\n', 'body\n\n'));
  const r = sh('stage_card_changes; echo "staged=$CARD_POSTS_STAGED skipped=$CARD_POSTS_SKIPPED"');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /staged=0 skipped=2/);
});

test('a refused auto-merge request warns and leaves the PR open; the job does not fail', () => {
  writeFileSync(join(clone, 'scripts/og/manifest.json'), '{"a":{"status":"batched"}}\n');
  const r = sh('stage_card_changes; publish_changes nightly-cards "chore(og): state"', { FAKE_GH_MERGE_FAIL: '1' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /WARNING: auto-merge not enabled for bot\/nightly-cards-\d{8}.*a human must merge it/);
  assert.match(readFileSync(ghLog, 'utf8'), /pr create -R SupportTools\/website/);
});

function bakedModules(version) {
  const dir = join(root, 'baked/node_modules');
  mkdirSync(join(dir, '@anthropic-ai/sdk'), { recursive: true });
  writeFileSync(join(dir, '@anthropic-ai/sdk/package.json'), JSON.stringify({ name: '@anthropic-ai/sdk', version }));
  writeFileSync(join(clone, 'package.json'), JSON.stringify({ dependencies: { '@anthropic-ai/sdk': '0.137.0' } }));
  return dir;
}

test('node_modules baked into the image are symlinked when the version matches; no npm', () => {
  const dir = bakedModules('0.137.0');
  const r = sh('ensure_node_deps', { JOB_NODE_MODULES: dir, NPM_REGISTRY: '' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /baked into the image \(@anthropic-ai\/sdk 0\.137\.0\)/);
  assert.equal(readFileSync(join(clone, 'node_modules/@anthropic-ai/sdk/package.json'), 'utf8').includes('0.137.0'), true);
});

test('baked node_modules at another version are not used; with no mirror the install refuses', () => {
  const dir = bakedModules('0.1.0');
  const r = sh('ensure_node_deps', { JOB_NODE_MODULES: dir, NPM_REGISTRY: '' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /baked @anthropic-ai\/sdk is 0\.1\.0, package\.json pins 0\.137\.0/);
  assert.match(r.out, /refusing to install npm dependencies from the public registry/);
  assert.equal(existsSync(join(clone, 'node_modules')), false);
});

// Push-only mode (INTERIM, TaskForge supporttools-website-990): no gh call, whatever
// GH_TOKEN holds. deploy-key has no token; app-push-only has an App token without
// pull-requests permission, so a gh call would be refused.
const PUSH_ONLY = {
  'deploy-key': { GH_TOKEN: '', WEBSITE_GIT_MODE: 'deploy-key' },
  'app-push-only': { GH_TOKEN: 'fake-app-token', WEBSITE_GIT_MODE: 'app-push-only' },
};

for (const [mode, env] of Object.entries(PUSH_ONLY)) {
  test(`${mode} mode: pushes the bot branch only, never main, and never calls gh`, () => {
    writeFileSync(join(clone, 'blog/content/post/a.md'), post('a', `images: ["${URL1}"]\n`));
    writeFileSync(join(clone, 'scripts/og/manifest.json'), JSON.stringify({ a: { status: 'live', url: URL1 } }, null, 1));
    const mainBefore = git(bare, 'rev-parse', 'main');
    const r = sh('stage_card_changes; check_live_cards_linked; publish_changes nightly-cards "chore(og): 1 more share cards (1 live)"', env);
    assert.equal(r.code, 0, r.out);
    const branch = `bot/nightly-cards-${day()}`;
    assert.equal(git(bare, 'rev-parse', 'main'), mainBefore);
    assert.equal(git(bare, 'log', '-1', '--format=%s', branch), 'chore(og): 1 more share cards (1 live)');
    assert.match(r.out, new RegExp(`${mode} mode: no PR opened here; the bot-pr workflow opens the PR for ${branch}`));
    assert.equal(existsSync(ghLog), false);
  });

  test(`${mode} mode: an earlier bot branch on the remote stops the job; today's and other kinds do not`, () => {
    git(clone, 'push', '-q', 'origin', `main:refs/heads/bot/nightly-cards-${day()}`);
    git(clone, 'push', '-q', 'origin', 'main:refs/heads/bot/daily-publish-20000101');
    git(clone, 'push', '-q', 'origin', 'main:refs/heads/bot/nightly-cards-20000101');
    let r = sh('refuse_if_earlier_bot_pr nightly-cards', env);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /earlier nightly-cards PR still open \(bot\/nightly-cards-20000101 \)/);
    // The merged PR's branch is deleted: the job runs again.
    git(clone, 'push', '-q', 'origin', ':refs/heads/bot/nightly-cards-20000101');
    r = sh('refuse_if_earlier_bot_pr nightly-cards', env);
    assert.equal(r.code, 0, r.out);
    assert.equal(existsSync(ghLog), false);
  });

  test(`${mode} mode: an unreachable remote stops the job instead of reading as "no branch"`, () => {
    git(clone, 'remote', 'set-url', 'origin', join(root, 'missing.git'));
    const r = sh('refuse_if_earlier_bot_pr nightly-cards', env);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /cannot list remote bot\/nightly-cards-\* branches; refusing to run/);
    assert.equal(existsSync(ghLog), false);
  });
}

test('an empty GH_TOKEN with WEBSITE_GIT_MODE unset, or an unknown mode, stops the job before any push', () => {
  writeFileSync(join(clone, 'blog/content/post/a.md'), post('a', `images: ["${URL1}"]\n`));
  writeFileSync(join(clone, 'scripts/og/manifest.json'), JSON.stringify({ a: { status: 'live', url: URL1 } }, null, 1));
  let r = sh('refuse_if_earlier_bot_pr nightly-cards; echo reached', { GH_TOKEN: '' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /GH_TOKEN is empty and WEBSITE_GIT_MODE is not deploy-key or app-push-only; refusing to run/);
  assert.doesNotMatch(r.out, /reached/);
  r = sh('stage_card_changes; publish_changes nightly-cards "chore(og): x"; echo reached', { GH_TOKEN: '' });
  assert.equal(r.code, 1, r.out);
  assert.doesNotMatch(r.out, /reached/);
  // A token does not make an unknown mode full App mode: a typo must not reach gh.
  for (const [i, extra] of [{ GH_TOKEN: '' }, {}].entries()) {
    // A refused publish_changes has already committed locally: stage a fresh change.
    writeFileSync(join(clone, 'scripts/og/manifest.json'), JSON.stringify({ a: { status: 'batched', batch: `batch_${i}` } }));
    r = sh('stage_card_changes; publish_changes nightly-cards "chore(og): x"; echo reached', { ...extra, WEBSITE_GIT_MODE: 'app-pushonly' });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /unknown WEBSITE_GIT_MODE app-pushonly; refusing to run/);
    assert.doesNotMatch(r.out, /reached/);
  }
  assert.equal(git(bare, 'ls-remote', '--heads', bare, 'refs/heads/bot/*'), '');
  assert.equal(existsSync(ghLog), false);
});

test('cards-nightly: a live card its post does not link still commits the manifest alone, then exits 1', () => {
  copyFileSync(resolve('scripts/jobs/cards-nightly.sh'), join(clone, 'scripts/jobs/cards-nightly.sh'));
  const dir = bakedModules('0.137.0');
  git(clone, 'add', '-A');
  git(clone, 'commit', '-q', '-m', 'job script');
  // Fake node: every run.mjs step "fails"; the manifest gains an in-flight batch and a
  // live card whose post was never edited.
  writeFileSync(join(root, 'bin/node'), [
    '#!/usr/bin/env bash',
    `printf '%s' '${JSON.stringify({ a: { status: 'live', url: URL1 }, b: { status: 'batched', batch: 'batch_1' } })}' > scripts/og/manifest.json`,
    'exit 2',
  ].join('\n'));
  chmodSync(join(root, 'bin/node'), 0o755);
  const env = {
    ...gitEnv(), PATH: `${join(root, 'bin')}:${process.env.PATH}`, FAKE_GH_LOG: ghLog, JOB_NODE_MODULES: dir,
    OG_WORK_DIR: join(root, 'work'), OPENAI_API_KEY: 'x', ANTHROPIC_API_KEY: 'x', OG_WASABI_ACCESS_KEY_ID: 'x', OG_WASABI_SECRET_ACCESS_KEY: 'x',
    WEBSITE_GIT_MODE: 'deploy-key',
  };
  const mainBefore = git(bare, 'rev-parse', 'main');
  const r = spawnSync('bash', ['scripts/jobs/cards-nightly.sh'], { cwd: clone, encoding: 'utf8', env });
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 1, out);
  assert.match(out, /MISMATCH a/);
  const branch = `bot/nightly-cards-${day()}`;
  assert.equal(git(bare, 'rev-parse', 'main'), mainBefore);
  assert.match(git(bare, 'log', '-1', '--format=%s', branch), /^chore\(og\): nightly card state only, live cards not linked \(1 live\)$/);
  assert.deepEqual(git(bare, 'diff', '--name-only', `${branch}~1`, branch).split('\n'), ['scripts/og/manifest.json']);
  assert.match(git(bare, 'show', `${branch}:scripts/og/manifest.json`), /batch_1/);
  // No GH_TOKEN in env: deploy-key mode, so the earlier-PR check and the push made no gh call.
  assert.equal(existsSync(ghLog), false);
  assert.match(out, /review provider: anthropic/);
});

test('cards-nightly: OG_REVIEW_PROVIDER=openai (INTERIM, #990) needs no Anthropic key and reaches run.mjs with openai', () => {
  copyFileSync(resolve('scripts/jobs/cards-nightly.sh'), join(clone, 'scripts/jobs/cards-nightly.sh'));
  const dir = bakedModules('0.137.0');
  git(clone, 'add', '-A');
  git(clone, 'commit', '-q', '-m', 'job script');
  const seen = join(root, 'node-env.log');
  writeFileSync(join(root, 'bin/node'), `#!/usr/bin/env bash\necho "$OG_IMAGE_PROVIDER $OG_REVIEW_PROVIDER \${ANTHROPIC_API_KEY:-none}" >> '${seen}'\n`);
  chmodSync(join(root, 'bin/node'), 0o755);
  const env = {
    ...gitEnv(), PATH: `${join(root, 'bin')}:${process.env.PATH}`, FAKE_GH_LOG: ghLog, JOB_NODE_MODULES: dir,
    OG_WORK_DIR: join(root, 'work'), OPENAI_API_KEY: 'x', OG_WASABI_ACCESS_KEY_ID: 'x', OG_WASABI_SECRET_ACCESS_KEY: 'x',
    // The interim config: the push-only App (a token gh must never use) and OpenAI review.
    OG_REVIEW_PROVIDER: 'openai', WEBSITE_GIT_MODE: 'app-push-only', GH_TOKEN: 'fake-app-token',
  };
  delete env.ANTHROPIC_API_KEY;
  const r = spawnSync('bash', ['scripts/jobs/cards-nightly.sh'], { cwd: clone, encoding: 'utf8', env });
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 0, out);
  assert.match(out, /review provider: openai/);
  assert.match(out, /nothing new/);
  assert.equal(existsSync(ghLog), false);
  const lines = readFileSync(seen, 'utf8').trim().split('\n');
  assert.equal(lines.length, 4);
  for (const l of lines) assert.equal(l, 'openai openai none');
  // Any other provider (the workstation claude-cli included) is refused in the job.
  const bad = spawnSync('bash', ['scripts/jobs/cards-nightly.sh'], { cwd: clone, encoding: 'utf8', env: { ...env, OG_REVIEW_PROVIDER: 'claude-cli' } });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /OG_REVIEW_PROVIDER must be anthropic or openai in the job, got claude-cli/);
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
  const env = { ...gitEnv(), OG_REVIEW_PROVIDER: 'openai' };
  for (const k of ['OG_WORK_DIR', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OG_WASABI_ACCESS_KEY_ID', 'OG_WASABI_SECRET_ACCESS_KEY']) delete env[k];
  const r = spawnSync('bash', [resolve('scripts/jobs/cards-nightly.sh')], { encoding: 'utf8', env });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing environment: OG_WORK_DIR OPENAI_API_KEY OG_WASABI_ACCESS_KEY_ID OG_WASABI_SECRET_ACCESS_KEY$/m);
});

test('weekly-social needs OG_WORK_DIR (the shared monthly ledger) for any run that calls Anthropic', () => {
  const env = { ...gitEnv(), ANTHROPIC_API_KEY: 'x', BUFFER_API_KEY: 'x' };
  delete env.OG_WORK_DIR;
  for (const args of [[], ['--dry-run']]) {
    const r = spawnSync('bash', [resolve('scripts/jobs/weekly-social.sh'), ...args], { encoding: 'utf8', env });
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, /missing environment: OG_WORK_DIR/);
  }
});
