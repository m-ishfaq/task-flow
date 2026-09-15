/**
 * WCAG contrast check — reads the ACTUAL oklch values from styles.css
 * (hardcoded to match exactly), not approximations.
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
  return pass;
}

// Exact values from styles.css @theme block — these are the source of truth
const surfaces = {
  surface:       { l: 16, c: 0.014, h: 55 },
  surfaceRaised: { l: 20, c: 0.017, h: 55 },
  surfaceSunken: { l: 12, c: 0.012, h: 55 },
};

const inks = {
  ink:      { l: 93, c: 0.01, h: 55 },
  inkMuted: { l: 78, c: 0.016, h: 55 },
  inkFaint: { l: 56, c: 0.015, h: 55 },
};

const accent     = { l: 60, c: 0.14, h: 88 };
const accentInk  = { l: 98, c: 0.01, h: 88 };
const accentHover = { l: 55, c: 0.14, h: 88 };

const urgent  = { l: 60, c: 0.19, h: 22 };
const medium  = { l: 60, c: 0.16, h: 88 };
const danger  = { l: 68, c: 0.19, h: 22 };

let fails = 0;

console.log('\n=== §2.4 Contrast Check (exact styles.css values) ===\n');

console.log('--- Text (ink on surfaces, 4.5:1) ---');
for (const [ik, iv] of Object.entries(inks)) {
  for (const [sn, sv] of Object.entries(surfaces)) {
    if (!check(`${ik} on ${sn}`, iv, sv, 4.5, 'text')) fails++;
  }
}

console.log('\n--- Button labels (accent-ink on accent, 4.5:1) ---');
if (!check('accent-ink on accent', accentInk, accent, 4.5, 'text')) fails++;
if (!check('accent-ink on accent-hover', accentInk, accentHover, 4.5, 'text')) fails++;

console.log('\n--- Non-text (accent on surfaces, 3:1) ---');
for (const [sn, sv] of Object.entries(surfaces)) {
  if (!check(`accent on ${sn}`, accent, sv, 3, 'non-text')) fails++;
}

console.log('\n--- Non-text (danger on surfaces, 3:1) ---');
for (const [sn, sv] of Object.entries(surfaces)) {
  if (!check(`danger on ${sn}`, danger, sv, 3, 'non-text')) fails++;
}

console.log('\n--- Non-text (priority swatches, 3:1) ---');
for (const [sn, sv] of Object.entries(surfaces)) {
  if (!check(`urgent on ${sn}`, urgent, sv, 3, 'non-text')) fails++;
  if (!check(`medium on ${sn}`, medium, sv, 3, 'non-text')) fails++;
}

console.log(`\n${fails === 0 ? '✅ All pass.' : `❌ ${fails} failures.`}`);
