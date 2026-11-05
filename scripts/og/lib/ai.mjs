// The two model calls: an image provider draws the illustration, Claude judges the
// finished card. The provider is OG_IMAGE_PROVIDER: "codex" (the default, the local
// CLI under the operator's login) or "openai" (the images API, lib/openai.mjs).
// The reviewer is OG_REVIEW_PROVIDER: "claude-cli" (the default, the local claude CLI
// under the operator's login) or "anthropic" (the Messages API with the card attached
// as an image, metered by lib/anthropic.mjs; for the in-cluster job).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
import { existsSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { generateImageOpenAI } from './openai.mjs';
import { makeClient, meteredCreate, anthropicLedgerPath, REVIEW_MODEL } from './anthropic.mjs';

export const PROVIDERS = ['codex', 'openai'];

export function imageProvider(env = process.env) {
  const p = env.OG_IMAGE_PROVIDER || 'codex';
  if (!PROVIDERS.includes(p)) throw new Error(`OG_IMAGE_PROVIDER must be one of ${PROVIDERS.join('|')}, got ${p}`);
  return p;
}

// Bump when the style text changes, so the manifest shows which cards used it.
export const PROMPT_VERSION = 1;

const STYLE = [
  'Clean modern technical illustration, dark navy background, teal and amber accent lights,',
  'isometric or schematic feel, professional (no cartoon mascots, no people).',
  'Absolutely NO text, letters, numbers, labels, logos or UI screenshots anywhere in the image.',
  'Keep the left 45% of the frame calm, dark and uncluttered: a title is overlaid there later.',
  'One clear focal subject on the right that reads at small thumbnail size.',
].join(' ');

// The codex prompt tells the agent to draw and save the file; the openai prompt is
// sent straight to the images endpoint, so it only describes the picture.
export function imagePrompt(post, excerptText, retryNote, provider = 'codex') {
  const lead = provider === 'openai'
    ? ['A landscape social-share header image for a technical blog article.']
    : [
      'Use your image generation tool to create ONE landscape social-share header image',
      '(about 1.91:1, e.g. 1536x804 or the closest landscape size you support) and save it',
      'in the current directory as raw.png. Do not create any other files.',
    ];
  return [
    ...lead,
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

// Writes <dir>/raw.png with the configured provider and returns its path.
export async function generateImage({ dir, prompt, timeoutMs, workDir }) {
  if (imageProvider() === 'openai') return generateImageOpenAI({ dir, prompt, workDir, timeoutMs });
  return generateImageCodex({ dir, prompt, timeoutMs });
}

async function generateImageCodex({ dir, prompt, timeoutMs = 600000 }) {
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

export const REVIEW_PROVIDERS = ['claude-cli', 'anthropic'];

export function reviewProvider(env = process.env) {
  const p = env.OG_REVIEW_PROVIDER || 'claude-cli';
  if (!REVIEW_PROVIDERS.includes(p)) throw new Error(`OG_REVIEW_PROVIDER must be one of ${REVIEW_PROVIDERS.join('|')}, got ${p}`);
  return p;
}

// The reviewer's instructions; `card` names the file for the CLI, which reads it
// itself. The API path attaches the image instead.
export function reviewPrompt(post, card) {
  return [
    card
      ? `You review social share images for a technical blog. Read the image file ${card}.`
      : 'You review social share images for a technical blog. The attached image is the card.',
    `Article title: ${JSON.stringify(post.title)}.`,
    post.description ? `Article summary: ${JSON.stringify(post.description)}.` : '',
    'Judge strictly: (1) the illustration plausibly depicts this specific article topic,',
    '(2) the scene is clean and readable at small thumbnail size,',
    '(3) no stray text, letters, numbers, logos or garbled shapes in the illustration itself',
    '(the topic chip, the title and "support.tools" at the left are intentional overlays).',
    'Reply with exactly one line of JSON:',
    '{"verdict":"pass"|"doubt","reason":"<one short sentence>"}',
  ].filter(Boolean).join(' ');
}

// workDir holds the Anthropic ledger (default: the card's parent, i.e. the run's work dir).
export async function reviewCard({ card, post, timeoutMs = 180000, workDir }) {
  if (reviewProvider() === 'anthropic') return reviewCardAnthropic({ card, post, workDir });
  const prompt = reviewPrompt(post, card);
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

// Same verdict from the Messages API. A missing key, a refused key (401/403) or the
// monthly cap halts the run (run.mjs exits 2, or 4 at the cap); anything the model
// says that is not a clean pass counts as doubt.
export async function reviewCardAnthropic({ card, post, workDir, client }) {
  const ledgerFile = anthropicLedgerPath(process.env, workDir || join(dirname(card), '..'));
  const params = {
    model: process.env.OG_ANTHROPIC_REVIEW_MODEL || REVIEW_MODEL,
    max_tokens: 4000,
    output_config: { effort: 'low' },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: readFileSync(card).toString('base64') } },
        { type: 'text', text: reviewPrompt(post) },
      ],
    }],
  };
  const c = client || await makeClient();
  const { message } = await meteredCreate({ ledgerFile, params, send: (p) => c.messages.create(p) });
  if (message.stop_reason === 'refusal') return { verdict: 'doubt', reason: 'reviewer declined to judge the card' };
  const text = (message.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  return parseVerdict(text);
}
