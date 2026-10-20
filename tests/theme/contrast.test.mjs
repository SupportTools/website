import test from 'node:test';
import assert from 'node:assert/strict';
import { contrastRatio, parseTokens, PAIRS, check } from '../../scripts/check-contrast.mjs';

test('contrastRatio black on white is 21', () => {
  assert.equal(contrastRatio('#000000', '#ffffff').toFixed(2), '21.00');
});

test('contrastRatio known value and argument order', () => {
  assert.equal(contrastRatio('#60a818', '#ffffff').toFixed(2), '2.95');
  assert.equal(contrastRatio('#ffffff', '#60a818'), contrastRatio('#60a818', '#ffffff'));
});

test('parseTokens reads all three blocks and lowercases values', () => {
  const scss = `
:root {
  --color-ink: #15251C;
  --space-1: 0.25rem;
  color-scheme: light;
}
:root[data-theme="dark"] {
  --color-ink: #E6EEE8;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) {
    --color-ink: #E6EEE8;
    --color-muted: #A8B9AD;
  }
}
`;
  const t = parseTokens(scss);
  assert.deepEqual(t.light, { 'color-ink': '#15251c' });
  assert.deepEqual(t.dark, { 'color-ink': '#e6eee8' });
  assert.deepEqual(t.darkMedia, { 'color-ink': '#e6eee8', 'color-muted': '#a8b9ad' });
});

function passingTokens() {
  const names = new Set(PAIRS.flatMap((p) => [p.fg, p.bg]));
  const mode = {};
  for (const n of names) mode[n] = '#000000';
  // make every pair pass: dark text on a white background
  for (const p of PAIRS) mode[p.bg] = '#ffffff';
  for (const p of PAIRS) mode[p.fg] = '#000000';
  return { light: { ...mode }, dark: { ...mode }, darkMedia: { ...mode } };
}

test('check passes on a fully compliant token set', () => {
  assert.deepEqual(check(passingTokens()), []);
});

test('check flags low-contrast syntax-kw on code surface', () => {
  const t = passingTokens();
  t.light['syntax-kw'] = '#e6db74';
  t.light['color-code-surface'] = '#edf1ed';
  const msgs = check(t);
  assert.ok(msgs.some((m) => m.includes('syntax-kw') && m.includes('4.5')), msgs.join('\n'));
});

test('check reports drift between dark and darkMedia', () => {
  const t = passingTokens();
  t.darkMedia['color-ink'] = '#111111';
  const msgs = check(t);
  assert.ok(msgs.some((m) => m.includes('color-ink') && /drift/i.test(m)), msgs.join('\n'));
});

test('check reports a missing token instead of throwing', () => {
  const t = passingTokens();
  delete t.dark['syntax-kw'];
  const msgs = check(t);
  assert.ok(msgs.some((m) => m.includes('syntax-kw') && /missing/i.test(m)), msgs.join('\n'));
});
