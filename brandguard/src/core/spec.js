'use strict';
// Brand spec: defaults, normalisation and validation. The spec is plain JSON so it can be
// shared between designers as a file.

const { normHex } = require('./color');

const DEFAULT_FORMATS = [
  { id: 'ig-portrait', name: 'Instagram portrait', width: 1080, height: 1350 },
  { id: 'ig-square', name: 'Instagram square', width: 1080, height: 1080 },
  // Stories/Reels: platform UI covers the top ~14% and bottom ~20%.
  { id: 'story', name: 'Story / Reel', width: 1080, height: 1920, safe: { top: 0.14, bottom: 0.2 } },
  { id: 'landscape', name: 'Facebook / LinkedIn', width: 1200, height: 628 },
  { id: 'x-post', name: 'X post', width: 1600, height: 900 },
  { id: 'yt-thumb', name: 'YouTube thumbnail', width: 1280, height: 720 },
  { id: 'pinterest', name: 'Pinterest pin', width: 1000, height: 1500 },
  { id: 'web-banner', name: 'Wide web banner', width: 1920, height: 600 },
];

const DEFAULT_SPEC = {
  name: 'My brand',
  palette: [
    { name: 'Ink', hex: '#111111' },
    { name: 'Paper', hex: '#FFFFFF' },
    { name: 'Accent', hex: '#E4572E' },
    { name: 'Muted', hex: '#6B7280' },
  ],
  colorTolerance: 5, // delta-E; <= this counts as on-palette
  fonts: ['Montserrat', 'Inter'], // family or PostScript prefix, e.g. "Montserrat" matches "Montserrat-Bold"
  safeMarginPct: 5, // % of the shorter canvas side kept clear of text/logos
  minTextPct: 2.5, // minimum text height as % of the shorter canvas side
  minContrast: 4.5, // WCAG ratio for text vs. backdrop (3.0 is used for large text)
  minPpi: 72, // raise to 300 for print work
  colorMode: 'RGB', // '' disables the check
  formats: DEFAULT_FORMATS,
};

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

function num(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Turn arbitrary (possibly hand-edited) input into a valid spec.
 * Returns { spec, errors } — errors lists everything that was dropped or defaulted.
 */
function normalizeSpec(raw) {
  const errors = [];
  const src = raw && typeof raw === 'object' ? raw : {};
  const d = DEFAULT_SPEC;
  const spec = {};

  spec.name = typeof src.name === 'string' && src.name.trim() ? src.name.trim().slice(0, 60) : d.name;

  spec.palette = [];
  const seen = new Set();
  for (const p of Array.isArray(src.palette) ? src.palette : clone(d.palette)) {
    const hex = normHex(p && p.hex);
    if (!hex) {
      errors.push(`Palette: "${p && p.hex}" is not a valid hex colour`);
      continue;
    }
    if (seen.has(hex)) continue;
    seen.add(hex);
    spec.palette.push({ name: String((p && p.name) || hex).slice(0, 40), hex });
  }

  spec.fonts = (Array.isArray(src.fonts) ? src.fonts : d.fonts)
    .map((f) => String(f).trim())
    .filter(Boolean);

  spec.colorTolerance = num(src.colorTolerance, d.colorTolerance, 0, 50);
  spec.safeMarginPct = num(src.safeMarginPct, d.safeMarginPct, 0, 25);
  spec.minTextPct = num(src.minTextPct, d.minTextPct, 0, 20);
  spec.minContrast = num(src.minContrast, d.minContrast, 1, 21);
  spec.minPpi = num(src.minPpi, d.minPpi, 0, 1200);
  spec.colorMode = ['RGB', 'CMYK', 'Grayscale', ''].includes(src.colorMode) ? src.colorMode : d.colorMode;

  spec.formats = [];
  const ids = new Set();
  for (const f of Array.isArray(src.formats) ? src.formats : clone(d.formats)) {
    const width = Math.round(Number(f && f.width));
    const height = Math.round(Number(f && f.height));
    if (!(width >= 16 && height >= 16 && width <= 30000 && height <= 30000)) {
      errors.push(`Format "${f && f.name}" has an invalid size`);
      continue;
    }
    let id = String((f && f.id) || `${width}x${height}`).replace(/[^\w-]/g, '-');
    while (ids.has(id)) id += '-2';
    ids.add(id);
    const out = { id, name: String((f && f.name) || id).slice(0, 40), width, height };
    if (f && f.safe && typeof f.safe === 'object') {
      out.safe = {};
      for (const side of ['top', 'right', 'bottom', 'left']) {
        if (f.safe[side] !== undefined) out.safe[side] = num(f.safe[side], 0, 0, 0.45);
      }
    }
    spec.formats.push(out);
  }
  return { spec, errors };
}

/** Per-side safe rectangle in pixels for a canvas, honouring a format's own safe overrides. */
function safeRect(width, height, spec, format) {
  const m = (spec.safeMarginPct / 100) * Math.min(width, height);
  const f = (format && format.safe) || {};
  const top = Math.max(m, (f.top || 0) * height);
  const bottom = Math.max(m, (f.bottom || 0) * height);
  const left = Math.max(m, (f.left || 0) * width);
  const right = Math.max(m, (f.right || 0) * width);
  return { left, top, right: width - right, bottom: height - bottom };
}

module.exports = { DEFAULT_SPEC, DEFAULT_FORMATS, normalizeSpec, safeRect, clone };
