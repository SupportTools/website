// The committed record of every share card: one entry per post slug. It lets a
// run resume where the last one stopped and is where flagged cards wait for a
// human. Written one entry per line so git diffs stay readable.
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';

// Statuses:
//   live      uploaded, verified through the CDN, frontmatter points at it
//   ready     passed review but not uploaded yet (uploads off or unavailable)
//   flagged   reviewer doubted it twice; waiting for approve or reject
//   approved  a human approved a flagged card; next run uploads it
//   rejected  a human rejected it; next run generates a fresh image
//   failed    generation or upload errored; next run retries
//   batched   sent to an OpenAI batch (batchId); collect-batch fetches the art
//   drawn     a batch drew raw.png; next run composes, reviews and uploads it
// Card files live in the gitignored .og-work/<slug>/ on the machine that ran.
//
// Optional entry fields: provider ("codex" or "openai", which drew the art; absent
// on entries from before providers existed means codex) and batchId (the OpenAI
// batch that drew or is drawing it, the same value as cards.batch_id in the
// publisher database). Older manifests without them load unchanged.
export const STATUSES = ['live', 'ready', 'flagged', 'approved', 'rejected', 'failed', 'batched', 'drawn'];

export function loadManifest(path) {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function serialize(manifest) {
  const keys = Object.keys(manifest).sort();
  if (!keys.length) return '{}\n';
  const rows = keys.map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(manifest[k])}`);
  return `{\n${rows.join(',\n')}\n}\n`;
}

export function saveManifest(path, manifest) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, serialize(manifest));
  renameSync(tmp, path);
}

// Whether a run should (re)make this post's card.
export function needsWork(entry) {
  // No status means a run stopped mid-card; redo it.
  return !entry || !entry.status || ['ready', 'approved', 'rejected', 'failed', 'drawn'].includes(entry.status);
}

// Whether --only-drawn picks this post up: art a batch drew, or a card that was
// already composed and passed review (or a human approved) but whose upload did not
// happen (uploads stopped, or the job died). Without the second half a stopped
// upload strands the card: the next night skips it, and nothing else uploads it.
export function finishable(entry, hasCard) {
  if (entry?.status === 'drawn') return true;
  return hasCard && ['ready', 'approved'].includes(entry?.status);
}
