/**
 * WCAG contrast checker — uses the CSS oklch values from styles.css
 * (the source of truth), not the mobile palette.
 */
import { gam_sRGB, OKLCH_to_XYZ_D65, XYZ_D65_to_lin_sRGB } from '@csstools/color-helpers';

function toLinear(l: number, c: number, h: number): [number, number, number] {
  const xyz = OKLCH_to_XYZ_D65([l / 100, c, h]);
  return XYZ_D65_to_lin_sRGB(xyz);
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const adjust = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * adjust(r) + 0.7152 * adjust(g) + 0.0722 * adjust(b);
}

function contrastRatio(l1: number, l2: number): number {
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function check(label: string, fg: {l:number;c:number;h:number}, bg: {l:number;c:number;h:number}, minRatio: number, type: 'text' | 'non-text') {
  const l1 = relativeLuminance(toLinear(fg.l, fg.c, fg.h));
  const l2 = relativeLuminance(toLinear(bg.l, bg.c, bg.h));
  const ratio = contrastRatio(l1, l2);
  const pass = ratio >= minRatio;
  console.log(`  ${pass ? '✅' : '❌'} ${label}: ${ratio.toFixed(2)}:1 (needs ${minRatio}:1 ${type})`);
  if (!pass) return false;
  return true;
}

// CSS values from styles.css (source of truth) — updated for §2.4 contrast fixes
const surfaces = {
  surface:       { l: 15.8, c: 0.0135, h: 55 },
  surfaceRaised: { l: 19.6, c: 0.0165, h: 55 },
  surfaceSunken: { l: 12.0, c: 0.0115, h: 55 },
};

const inks = {
  ink:      { l: 93.3, c: 0.013, h: 55 },
  inkMuted: { l: 75.0, c: 0.016, h: 55 },   // was L=66, fixed to L=75 for 4.5:1
  inkFaint: { l: 54.8, c: 0.015, h: 55 },   // intentionally below text threshold
};

// Accent — CSS values
const accent     = { l: 72.2, c: 0.143, h: 88 };
const accentInk  = { l: 50.0, c: 0.020, h: 88 };  // was L=16, fixed to L=50 for 4.5:1
const accentHover = { l: 66.0, c: 0.143, h: 88 };

// Priority — CSS values
const urgent  = { l: 59.7, c: 0.191, h: 22 };
const medium  = { l: 60.0, c: 0.159, h: 88 };
const danger  = { l: 48.0, c: 0.19, h: 22 };  // was L=55, fixed to L=48 for 3:1

let failCount = 0;

console.log('\n=== §2.4 Contrast Check (CSS values) ===\n');

console.log('--- Text (ink on surfaces) ---');
for (const [inkName, ink] of Object.entries(inks)) {
  for (const [surfName, surf] of Object.entries(surfaces)) {
    if (!check(`${inkName} on ${surfName}`, ink, surf, 4.5, 'text')) failCount++;
  }
}

console.log('\n--- Button labels (accent-ink on accent) ---');
if (!check('accent-ink on accent', accentInk, accent, 4.5, 'text')) failCount++;
if (!check('accent-ink on accent-hover', accentInk, accentHover, 4.5, 'text')) failCount++;

console.log('\n--- Non-text (accent on surfaces — border, ring, icon) ---');
for (const [surfName, surf] of Object.entries(surfaces)) {
  if (!check(`accent on ${surfName}`, accent, surf, 3, 'non-text')) failCount++;
}

console.log('\n--- Non-text (danger on surfaces — delete buttons, error states) ---');
for (const [surfName, surf] of Object.entries(surfaces)) {
  if (!check(`danger on ${surfName}`, danger, surf, 3, 'non-text')) failCount++;
}

console.log('\n--- Non-text (priority swatches) ---');
for (const [surfName, surf] of Object.entries(surfaces)) {
  if (!check(`urgent on ${surfName}`, urgent, surf, 3, 'non-text')) failCount++;
  if (!check(`medium on ${surfName}`, medium, surf, 3, 'non-text')) failCount++;
}

console.log(`\n${failCount === 0 ? '✅ All pass.' : `❌ ${failCount} failures.`}`);
