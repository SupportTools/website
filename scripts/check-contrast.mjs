// WCAG 2.x contrast gate for the m10c theme color tokens.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DEFAULT_SCSS = 'blog/themes/m10c/assets/css/_base.scss';
const DEFAULT_EXTRA_SCSS = 'blog/themes/m10c/assets/css/_extra.scss';
const HEX = /^#[0-9a-f]{6}$/;

function channel(v) {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrastRatio(fg, bg) {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

function parseBlock(body) {
  const out = {};
  for (const m of body.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    const value = m[2].trim().toLowerCase();
    if (HEX.test(value)) out[m[1]] = value;
  }
  return out;
}

export function parseTokens(scss) {
  const block = (re) => {
    const m = scss.match(re);
    return m ? parseBlock(m[1]) : {};
  };
  return {
    light: block(/(?:^|\n):root\s*\{([^}]*)\}/),
    dark: block(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/),
    darkMedia: block(/:root:not\(\[data-theme\]\)\s*\{([^}]*)\}/),
  };
}

const pairs = (min, bg, fgs) => fgs.map((fg) => ({ fg, bg, min }));

export const PAIRS = [
  ...pairs(4.5, 'color-canvas', ['color-ink', 'color-muted', 'color-accent', 'color-visited']),
  ...pairs(4.5, 'color-surface', ['color-ink', 'color-muted', 'color-accent']),
  ...pairs(4.5, 'color-code-surface', [
    'syntax-text', 'syntax-kw', 'syntax-str', 'syntax-fn', 'syntax-com', 'syntax-num', 'color-muted',
  ]),
  ...pairs(4.5, 'color-chip', ['color-chip-ink']),
  ...pairs(4.5, 'color-button', ['color-on-button']),
  ...pairs(4.5, 'color-header', ['color-header-ink', 'color-header-muted']),
  ...pairs(4.5, 'color-warn-bg', ['color-warn-ink', 'color-ink']),
  ...pairs(4.5, 'color-selection', ['color-ink']),
  ...pairs(3, 'color-canvas', ['color-focus', 'color-warn-line', 'color-border-strong']),
  ...pairs(3, 'color-code-surface', ['color-focus']),
  ...pairs(3, 'color-header', ['color-header-focus']),
];

export const PF_ROLES = {
  '--pf-mark': 4.5,
  '--pf-text': 4.5,
  '--pf-text-secondary': 4.5,
  '--pf-text-muted': 4.5,
  '--pf-border': 3,
  '--pf-border-focus': 3,
  '--pf-outline-focus': 3,
};

export function parsePfMappings(scss) {
  const out = {};
  for (const m of scss.matchAll(/(--pf-[a-z0-9-]+)\s*:\s*var\(--([a-z0-9-]+)\)\s*;/gi)) {
    if (m[1] in PF_ROLES) out[m[1]] = m[2];
  }
  return out;
}

export function checkPagefind(tokens, mappings) {
  const failures = [];
  for (const [prop, min] of Object.entries(PF_ROLES)) {
    const token = mappings[prop];
    if (!token) {
      failures.push(`pagefind: ${prop} has no var(--token) mapping`);
      continue;
    }
    for (const mode of ['light', 'dark']) {
      const set = tokens[mode] || {};
      const missing = [token, 'color-surface'].filter((t) => !set[t]);
      if (missing.length) {
        failures.push(`${mode}: missing token ${missing.join(', ')} (needed for ${prop} -> ${token} on color-surface)`);
        continue;
      }
      const ratio = contrastRatio(set[token], set['color-surface']);
      if (ratio < min) failures.push(`${mode}: ${token} on color-surface ${ratio.toFixed(2)} < ${min} (${prop})`);
    }
  }
  return failures;
}

export function check(tokens) {
  const failures = [];
  for (const mode of ['light', 'dark']) {
    const set = tokens[mode] || {};
    for (const { fg, bg, min } of PAIRS) {
      const missing = [fg, bg].filter((t) => !set[t]);
      if (missing.length) {
        failures.push(`${mode}: missing token ${missing.join(', ')} (needed for ${fg} on ${bg})`);
        continue;
      }
      const ratio = contrastRatio(set[fg], set[bg]);
      if (ratio < min) failures.push(`${mode}: ${fg} on ${bg} ${ratio.toFixed(2)} < ${min}`);
    }
  }
  const dark = tokens.dark || {};
  const media = tokens.darkMedia || {};
  for (const key of [...new Set([...Object.keys(dark), ...Object.keys(media)])].sort()) {
    if (!(key in dark)) failures.push(`drift: ${key} missing from dark block (darkMedia has ${media[key]})`);
    else if (!(key in media)) failures.push(`drift: ${key} missing from darkMedia block (dark has ${dark[key]})`);
    else if (dark[key] !== media[key]) failures.push(`drift: ${key} dark ${dark[key]} != darkMedia ${media[key]}`);
  }
  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2] || DEFAULT_SCSS;
  const extraPath = process.argv[3] || DEFAULT_EXTRA_SCSS;
  const tokens = parseTokens(readFileSync(path, 'utf8'));
  const failures = [
    ...check(tokens),
    ...checkPagefind(tokens, parsePfMappings(readFileSync(extraPath, 'utf8'))),
  ];
  if (failures.length) {
    console.error(`Contrast check failed (${failures.length}) for ${path} and ${extraPath}:`);
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(`Contrast check passed for ${path} and ${extraPath}`);
}
