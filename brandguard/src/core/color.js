'use strict';
// Colour helpers: hex parsing, CIE76 delta-E, WCAG contrast.

function normHex(hex) {
  if (typeof hex !== 'string') return null;
  let h = hex.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(h)) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return '#' + h.toUpperCase();
}

function hexToRgb(hex) {
  const n = normHex(hex);
  if (!n) return null;
  const v = parseInt(n.slice(1), 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}

function rgbToHex(r, g, b) {
  const c = (x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0');
  return ('#' + c(r) + c(g) + c(b)).toUpperCase();
}

function toLinear(c) {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function relLuminance(hex) {
  const c = hexToRgb(hex);
  if (!c) return 0;
  return 0.2126 * toLinear(c.r) + 0.7152 * toLinear(c.g) + 0.0722 * toLinear(c.b);
}

function contrastRatio(hexA, hexB) {
  const a = relLuminance(hexA);
  const b = relLuminance(hexB);
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

function toLab(hex) {
  const c = hexToRgb(hex);
  const r = toLinear(c.r);
  const g = toLinear(c.g);
  const b = toLinear(c.b);
  // sRGB D65 -> XYZ
  const x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  const y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
  const z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return { L: 116 * f(y) - 16, a: 500 * (f(x) - f(y)), b: 200 * (f(y) - f(z)) };
}

/** CIE76 delta-E. ~2.3 is a just-noticeable difference. */
function deltaE(hexA, hexB) {
  const a = toLab(hexA);
  const b = toLab(hexB);
  return Math.sqrt((a.L - b.L) ** 2 + (a.a - b.a) ** 2 + (a.b - b.b) ** 2);
}

/** Closest palette entry to `hex`: { entry, dE } or null for an empty palette. */
function nearest(palette, hex) {
  let best = null;
  for (const entry of palette) {
    const dE = deltaE(entry.hex, hex);
    if (!best || dE < best.dE) best = { entry, dE };
  }
  return best;
}

module.exports = { normHex, hexToRgb, rgbToHex, relLuminance, contrastRatio, deltaE, nearest };
