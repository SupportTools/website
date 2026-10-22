// The two model calls: Codex draws the illustration, Claude judges the finished
// card. Both run as local CLIs under the operator's existing logins.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
import { existsSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Bump when the style text changes, so the manifest shows which cards used it.
export const PROMPT_VERSION = 1;

const STYLE = [
  'Clean modern technical illustration, dark navy background, teal and amber accent lights,',
  'isometric or schematic feel, professional (no cartoon mascots, no people).',
  'Absolutely NO text, letters, numbers, labels, logos or UI screenshots anywhere in the image.',
  'Keep the left 45% of the frame calm, dark and uncluttered: a title is overlaid there later.',
  'One clear focal subject on the right that reads at small thumbnail size.',
].join(' ');

export function imagePrompt(post, excerptText, retryNote) {
  return [
    'Use your image generation tool to create ONE landscape social-share header image',
    '(about 1.91:1, e.g. 1536x804 or the closest landscape size you support) and save it',
    'in the current directory as raw.png. Do not create any other files.',
    `Style: ${STYLE}`,
    'Subject: a visual metaphor for the specific problem, mechanism or trade-off this article is',
    'about (not a generic "cloud" or "server rack" picture). Pick one concrete scene a reader of',
    'the article would recognise.',
    retryNote ? `A reviewer rejected the previous attempt: "${retryNote}". Fix that.` : '',
    '',
    `Article title: ${post.title}`,
    post.description ? `Article summary: ${post.description}` : '',
    `Article opening:\n${excerptText}`,
  ].filter((l) => l !== '').join('\n');
}

export async function generateImage({ dir, prompt, timeoutMs = 600000 }) {
  writeFileSync(join(dir, 'prompt.txt'), prompt);
  const raw = join(dir, 'raw.png');
  rmSync(raw, { force: true });
  // --ignore-user-config skips ~/.codex/config.toml (its MCP servers and plugins start
  // per exec); login still comes from CODEX_HOME. Model settings are pinned here instead.
  const pending = run('codex', [
    'exec', '--ignore-user-config',
    '-c', `model=${process.env.OG_CODEX_MODEL || 'gpt-5.6-sol'}`,
    '-c', `model_reasoning_effort=${process.env.OG_CODEX_EFFORT || 'high'}`,
    '--skip-git-repo-check', '--sandbox', 'workspace-write', '-C', dir,
    '-o', join(dir, 'codex-last.txt'), prompt,
  ], { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  // codex exec also reads stdin until EOF; an open pipe makes it wait forever.
  pending.child.stdin.end();
  let stdout, stderr;
  try {
    ({ stdout, stderr } = await pending);
  } catch (e) {
    // execFile's message is only the command line; the cause (usage limit, login) is in the output.
    writeFileSync(join(dir, 'codex.log'), `${e.stdout || ''}\n${e.stderr || ''}`);
    const lines = `${e.stdout || ''}\n${e.stderr || ''}`.split('\n').map((l) => l.trim()).filter(Boolean);
    const cause = lines.findLast((l) => /error|limit|quota|log ?in|unauthori[sz]ed|\b4\d\d\b/i.test(l)) || lines.at(-1);
    throw new Error(`codex exited ${e.code ?? e.signal}: ${cause || 'no output'}`);
  }
  writeFileSync(join(dir, 'codex.log'), `${stdout}\n${stderr}`);
  if (!existsSync(raw)) throw new Error('codex finished without writing raw.png');
  const { stdout: dims } = await run('magick', ['identify', '-format', '%w %h', raw]);
  const [w, h] = dims.split(' ').map(Number);
  if (!(w > h * 1.4)) throw new Error(`raw.png is not landscape (${w}x${h})`);
  return raw;
}

// Parses the reviewer's one-line JSON. Anything unparseable counts as doubt, so
// a confused reviewer can never wave a card through.
export function parseVerdict(out) {
  const m = String(out).match(/\{[^{}]*"verdict"[^{}]*\}/);
  if (!m) return { verdict: 'doubt', reason: 'reviewer gave no verdict' };
  try {
    const v = JSON.parse(m[0]);
    return { verdict: v.verdict === 'pass' ? 'pass' : 'doubt', reason: String(v.reason || '') };
  } catch {
    return { verdict: 'doubt', reason: 'reviewer verdict was not valid JSON' };
  }
}

export async function reviewCard({ card, post, timeoutMs = 180000 }) {
  const prompt = [
    `You review social share images for a technical blog. Read the image file ${card}.`,
    `Article title: ${JSON.stringify(post.title)}.`,
    post.description ? `Article summary: ${JSON.stringify(post.description)}.` : '',
    'Judge strictly: (1) the illustration plausibly depicts this specific article topic,',
    '(2) the scene is clean and readable at small thumbnail size,',
    '(3) no stray text, letters, numbers, logos or garbled shapes in the illustration itself',
    '(the topic chip, the title and "support.tools" at the left are intentional overlays).',
    'Reply with exactly one line of JSON:',
    '{"verdict":"pass"|"doubt","reason":"<one short sentence>"}',
  ].filter(Boolean).join(' ');
  const dir = card.replace(/\/[^/]+$/, '');
  const pending = run('claude', [
    '-p', '--model', 'sonnet', '--strict-mcp-config', '--setting-sources', '',
    '--no-session-persistence', '--allowedTools', 'Read', '--add-dir', dir,
    '--output-format', 'text', prompt,
  ], { cwd: dir, timeout: timeoutMs });
  pending.child.stdin.end();
  const { stdout } = await pending;
  return parseVerdict(stdout);
}
