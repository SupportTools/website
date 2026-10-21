// Composes the final 1200x630 share card from a raw Codex illustration: a dark
// left fade, a topic chip, the short title and the support.tools mark. Text is
// drawn here, never by the image model, so type is identical on every card.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const WIDTH = 1200;
export const HEIGHT = 630;
export const FONT = process.env.OG_FONT || '/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf';

const NAVY = '#0a1220';
const TEAL = '#2dd4bf';
const CHIP_TEXT = '#0f1b2d';
const MAX_TITLE = 72;
const TITLE_W = 470;

// The card shows the part of the title before the first ": " (the hook), or the
// whole title when there is no subtitle. Overlong titles are cut at a word.
export function shortTitle(title) {
  const t = String(title || '').trim();
  const head = t.includes(': ') ? t.slice(0, t.indexOf(': ')).trim() : t;
  if (head.length <= MAX_TITLE) return head;
  const cut = head.slice(0, MAX_TITLE + 1);
  return cut.slice(0, cut.lastIndexOf(' ')).replace(/[\s,;:-]+$/, '');
}

export function chipLabel(categories) {
  const c = (categories || []).find(Boolean);
  return c ? c.toUpperCase() : 'SUPPORT.TOOLS';
}

// Alpha of the navy fade at horizontal position px (0..1): 0.92 at the left
// edge, 0.85 at 45% (the title column), clear from 72%.
// (fx reserves single letters such as u, so the position is named px.)
const FADE_FX = 'px=i/w; px<0.45 ? 0.92-0.07*px/0.45 : (px<0.72 ? 0.85*(0.72-px)/0.27 : 0)';

// Fixed steps rather than auto-fit, so short hooks read big and long titles
// still fit in four lines of the title column. The column stays inside the
// left 45% that Codex is told to keep clear.
export function titlePointsize(text) {
  if (text.length <= 24) return 72;
  if (text.length <= 44) return 56;
  return 46;
}

export async function composeCard({ raw, out, title, categories }) {
  const label = chipLabel(categories);
  const text = shortTitle(title);
  await run('magick', [
    raw,
    '-resize', `${WIDTH}x${HEIGHT}^`, '-gravity', 'center', '-extent', `${WIDTH}x${HEIGHT}`,
    '(', '-size', `${WIDTH}x${HEIGHT}`, `xc:${NAVY}`,
    '(', '-size', `${WIDTH}x${HEIGHT}`, 'xc:black', '-fx', FADE_FX, ')',
    '-alpha', 'off', '-compose', 'CopyOpacity', '-composite', ')',
    '-gravity', 'northwest', '-compose', 'over', '-composite',
    '(', '+size', '-background', TEAL, '-fill', CHIP_TEXT, '-font', FONT, '-pointsize', '18',
    '-kerning', '1.5', `label:${label}`, '-bordercolor', TEAL, '-border', '14x7', ')',
    '-geometry', '+64+64', '-composite',
    '(', '-size', `${TITLE_W}x`, '-background', 'none', '-fill', 'white', '-font', FONT,
    '-kerning', '0', '-pointsize', String(titlePointsize(text)), '-interline-spacing', '-4',
    `caption:${text}`, '-trim', '+repage', ')',
    '-geometry', '+64+128', '-composite',
    '-fill', 'white', '-font', FONT, '-pointsize', '24', '-annotate', `+64+${HEIGHT - 84}`, 'support.tools',
    '-strip', '-interlace', 'Plane', '-sampling-factor', '4:2:0', '-quality', '82',
    out,
  ]);
  return out;
}
