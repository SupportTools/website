// Guards on the INTERIM (TaskForge supporttools-website-990) deploy-key workflows:
// bot-pr.yml opens PRs and never merges; bot branch pushes run Test but never deploy.
// Text checks on the shipped YAML (no YAML parser in the dependencies).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const botPr = readFileSync('.github/workflows/bot-pr.yml', 'utf8');
const cf = readFileSync('.github/workflows/cloudflare-workers.yml', 'utf8');
// Comments stripped, so prose about merging cannot satisfy or trip a check.
const code = (s) => s.split('\n').filter((l) => !/^\s*#/.test(l)).map((l) => l.replace(/\s+#\s.*$/, '')).join('\n');

test('bot-pr.yml: bot/** pushes only, least privilege, opens a PR and never merges', () => {
  const c = code(botPr);
  assert.match(c, /on:\n {2}push:\n {4}branches:\n {6}- 'bot\/\*\*'\n\n/);
  assert.doesNotMatch(c, /pull_request:|workflow_run|schedule:/);
  assert.match(c, /\npermissions:\n {2}contents: read\n {2}pull-requests: write\n\n/);
  assert.match(c, /gh pr create -R "\$REPO" --base main --head "\$BRANCH"/);
  assert.doesNotMatch(c, /pr merge|--auto|enablePullRequestAutoMerge|mergePullRequest|pulls\/\S+\/merge/);
  // The commit subject is data: only ever read from env.
  assert.doesNotMatch(c.split('run: |')[1], /\$\{\{/);
});

test('cloudflare-workers.yml: bot/** pushes run Test; Deploy-Production stays main-only', () => {
  assert.match(code(cf), /push:\n {4}branches:\n {6}- main\n {6}- 'bot\/\*\*'\n/);
  const deploy = cf.slice(cf.indexOf('  Deploy-Production:'));
  assert.match(deploy, /\n {4}if: \(github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'\) \|\| github\.event_name == 'schedule'\n/);
});
