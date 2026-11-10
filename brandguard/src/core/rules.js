'use strict';
// Preflight rules. Each rule reads the document model + brand spec and emits findings:
//   { id, rule, severity: 'error'|'warn'|'info', layerId|null, layerName, title, message,
//     fix: null | { type, layerId, label, safe, ...params } }
// Fix descriptors are plain data: the Photoshop adapter executes them, applyFixToModel()
// replays them on the in-memory model (used for tests, previews and variant validation).

const color = require('./color');
const { walk, w, h, hasBounds, inferRoles, SAFE_ROLES } = require('./roles');
const { safeRect } = require('./spec');

const SEVERITY_ORDER = { error: 0, warn: 1, info: 2 };
const px = (n) => Math.round(n);

function fontAllowed(font, allowed) {
  if (!allowed.length) return true;
  const norm = (s) => String(s).toLowerCase().replace(/[\s_-]+/g, '');
  const f = norm(font);
  return allowed.some((a) => f.startsWith(norm(a)));
}

/** Colour of the nearest visible solid layer underneath `target` that covers its centre. */
function backdropFor(doc, flat, target) {
  if (target.layer.backdropHex) return color.normHex(target.layer.backdropHex);
  const b = target.layer.bounds;
  if (!b) return null;
  const cx = (b.left + b.right) / 2;
  const cy = (b.top + b.bottom) / 2;
  for (let i = flat.indexOf(target) + 1; i < flat.length; i++) {
    const l = flat[i].layer;
    if (!l.visible || !l.fillHex || !l.bounds) continue;
    if (cx >= l.bounds.left && cx <= l.bounds.right && cy >= l.bounds.top && cy <= l.bounds.bottom) {
      return color.normHex(l.fillHex);
    }
  }
  return null;
}

function bestContrastColor(spec, current, backdrop, need) {
  const ok = spec.palette
    .map((p) => ({ hex: p.hex, name: p.name, ratio: color.contrastRatio(p.hex, backdrop) }))
    .filter((c) => c.ratio >= need);
  if (ok.length) {
    ok.sort((a, b) => color.deltaE(a.hex, current) - color.deltaE(b.hex, current));
    return ok[0];
  }
  const fallback = ['#000000', '#FFFFFF']
    .map((hex) => ({ hex, name: hex, ratio: color.contrastRatio(hex, backdrop) }))
    .sort((a, b) => b.ratio - a.ratio)[0];
  return fallback;
}

const DEFAULT_NAME = /^(layer|group|rectangle|ellipse|shape|polygon|line|path|artboard)\s*\d+(\s+copy(\s*\d+)?)?$/i;
const ROLE_LABEL = {
  background: 'Background',
  logo: 'Logo',
  headline: 'Headline',
  body: 'Body',
  cta: 'CTA',
  image: 'Image',
  graphic: 'Graphic',
  group: 'Group',
};

function audit(doc, spec, ctx) {
  const opts = ctx || {};
  const findings = [];
  const minSide = Math.min(doc.width, doc.height);
  const safe = safeRect(doc.width, doc.height, spec, opts.format);
  const roles = inferRoles(doc);
  const flat = [...walk(doc.layers)];

  const add = (f) => findings.push(Object.assign({ layerId: null, layerName: '', fix: null }, f));
  const forLayer = (l) => ({ layerId: l.id, layerName: l.name });

  // ---- document level -----------------------------------------------------------------
  if (spec.colorMode && doc.colorMode && doc.colorMode !== spec.colorMode) {
    add({
      id: 'color-mode:doc', rule: 'color-mode', severity: 'warn', title: 'Colour mode',
      message: `Document is ${doc.colorMode}; the brand spec expects ${spec.colorMode}. Use Image › Mode to convert.`,
    });
  }
  if (spec.minPpi && doc.resolution && doc.resolution < spec.minPpi) {
    add({
      id: 'resolution:doc', rule: 'resolution', severity: 'warn', title: 'Resolution',
      message: `${doc.resolution} ppi is below the ${spec.minPpi} ppi minimum.`,
    });
  }

  // ---- per layer ----------------------------------------------------------------------
  const nameCounters = {};
  for (const item of flat) {
    const l = item.layer;
    const parentHidden = item.parent && !item.parent.visible;
    const role = roles[l.id];

    if (opts.hygiene !== false) {
      if (!l.visible && !parentHidden) {
        add({
          id: `hidden:${l.id}`, rule: 'hidden-layer', severity: 'info', ...forLayer(l), title: 'Hidden layer',
          message: 'Hidden layers ship with the file and can leak old copy or ideas.',
          fix: { type: 'delete', layerId: l.id, label: 'Delete', safe: false },
        });
      }
      if (l.kind === 'pixel' && l.empty && !parentHidden) {
        add({
          id: `empty:${l.id}`, rule: 'empty-layer', severity: 'warn', ...forLayer(l), title: 'Empty layer',
          message: 'This layer has no pixels.',
          fix: { type: 'delete', layerId: l.id, label: 'Delete', safe: false },
        });
      }
      if (l.visible && hasBounds(l) && l.kind !== 'group' &&
          (l.bounds.right <= 0 || l.bounds.bottom <= 0 || l.bounds.left >= doc.width || l.bounds.top >= doc.height)) {
        add({
          id: `off-canvas:${l.id}`, rule: 'off-canvas', severity: 'warn', ...forLayer(l), title: 'Off canvas',
          message: 'Visible layer sits entirely outside the canvas.',
          fix: { type: 'delete', layerId: l.id, label: 'Delete', safe: false },
        });
      }
      if (l.kind !== 'text' && DEFAULT_NAME.test((l.name || '').trim())) {
        const base = ROLE_LABEL[role] || ({ pixel: 'Image', smart: 'Smart object', shape: 'Shape', solid: 'Fill' }[l.kind]) || 'Layer';
        nameCounters[base] = (nameCounters[base] || 0) + 1;
        add({
          id: `name:${l.id}`, rule: 'default-name', severity: 'info', ...forLayer(l), title: 'Unnamed layer',
          message: `"${l.name}" is a default name.`,
          fix: { type: 'rename', layerId: l.id, name: `${base} ${nameCounters[base]}`, label: `Rename → ${base} ${nameCounters[base]}`, safe: true },
        });
      }
    }

    if (!l.visible || parentHidden) continue;

    // Text rules
    if (l.kind === 'text' && l.text) {
      const t = l.text;
      if (spec.fonts.length && t.font && !fontAllowed(t.font, spec.fonts)) {
        add({
          id: `font:${l.id}`, rule: 'font', severity: 'error', ...forLayer(l), title: 'Off-brand font',
          message: `${t.font} is not in the brand fonts (${spec.fonts.join(', ')}).`,
          fix: { type: 'setFont', layerId: l.id, font: spec.fonts[0], label: `Use ${spec.fonts[0]}`, safe: true },
        });
      }
      const minPx = (spec.minTextPct / 100) * minSide;
      if (spec.minTextPct && t.sizePx && t.sizePx < minPx) {
        add({
          id: `min-text:${l.id}`, rule: 'min-text', severity: 'warn', ...forLayer(l), title: 'Text too small',
          message: `${px(t.sizePx)} px is below the ${px(minPx)} px minimum for this canvas.`,
          fix: { type: 'setSize', layerId: l.id, sizePx: Math.ceil(minPx), label: `Set ${Math.ceil(minPx)} px`, safe: true },
        });
      }
      if (t.colorHex && spec.palette.length) {
        const near = color.nearest(spec.palette, t.colorHex);
        pushPaletteFinding(add, l, near, t.colorHex, spec, 'Text colour');
      }
      const backdrop = t.colorHex ? backdropFor(doc, flat, item) : null;
      if (backdrop) {
        const large = t.sizePx >= 0.05 * minSide;
        const need = large ? Math.min(3, spec.minContrast) : spec.minContrast;
        const ratio = color.contrastRatio(t.colorHex, backdrop);
        if (ratio < need) {
          const pick = bestContrastColor(spec, t.colorHex, backdrop, need);
          add({
            id: `contrast:${l.id}`, rule: 'contrast', severity: 'warn', ...forLayer(l), title: 'Low contrast',
            message: `${ratio.toFixed(1)}:1 against ${backdrop}; needs ${need}:1.`,
            fix: { type: 'setColor', layerId: l.id, hex: pick.hex, label: `Use ${pick.name} ${pick.name === pick.hex ? '' : pick.hex}`.trim(), safe: true },
          });
        }
      }
    }

    // Solid-colour layers must be on-palette too.
    if (l.fillHex && spec.palette.length) {
      pushPaletteFinding(add, l, color.nearest(spec.palette, l.fillHex), l.fillHex, spec, 'Fill colour');
    }

    // Safe zone — only for things that carry content, only top-level so groups move as a unit.
    if (!item.parent && SAFE_ROLES.has(role) && hasBounds(l)) {
      const b = l.bounds;
      const wide = w(b) > safe.right - safe.left + 0.5;
      const tall = h(b) > safe.bottom - safe.top + 0.5;
      let dx = 0;
      let dy = 0;
      if (!wide) dx = b.left < safe.left ? safe.left - b.left : b.right > safe.right ? safe.right - b.right : 0;
      if (!tall) dy = b.top < safe.top ? safe.top - b.top : b.bottom > safe.bottom ? safe.bottom - b.bottom : 0;
      if (wide || tall || Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        add({
          id: `safe-zone:${l.id}`, rule: 'safe-zone', severity: 'warn', ...forLayer(l), title: 'Outside safe zone',
          message: wide || tall
            ? 'Larger than the safe area; scale it down.'
            : `${px(Math.max(Math.abs(dx), Math.abs(dy)))} px past the safe margin.`,
          fix: wide || tall ? null : { type: 'moveBy', layerId: l.id, dx: px(dx), dy: px(dy), label: 'Nudge inside', safe: true },
        });
      }
    }
  }

  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return findings;
}

function pushPaletteFinding(add, layer, near, hex, spec, what) {
  if (!near || near.dE <= 0.5) return;
  const snap = {
    type: 'setColor', layerId: layer.id, hex: near.entry.hex, safe: true,
    label: `Snap to ${near.entry.name} ${near.entry.hex}`,
  };
  if (near.dE <= spec.colorTolerance) {
    add({
      id: `palette:${layer.id}`, rule: 'palette', severity: 'info', layerId: layer.id, layerName: layer.name,
      title: 'Near-miss colour',
      message: `${what} ${hex} is ΔE ${near.dE.toFixed(1)} from ${near.entry.name} ${near.entry.hex}.`,
      fix: snap,
    });
  } else {
    add({
      id: `palette:${layer.id}`, rule: 'palette', severity: 'warn', layerId: layer.id, layerName: layer.name,
      title: 'Off-palette colour',
      message: `${what} ${hex} is not in the palette (closest: ${near.entry.name}, ΔE ${near.dE.toFixed(0)}).`,
      fix: snap,
    });
  }
}

function summarize(findings) {
  const s = { error: 0, warn: 0, info: 0 };
  for (const f of findings) s[f.severity]++;
  return s;
}

// ---- replaying fixes on the model --------------------------------------------------------

function cloneDoc(doc) {
  return JSON.parse(JSON.stringify(doc));
}

function translate(layer, dx, dy) {
  if (layer.bounds) {
    layer.bounds.left += dx; layer.bounds.right += dx;
    layer.bounds.top += dy; layer.bounds.bottom += dy;
  }
  (layer.children || []).forEach((c) => translate(c, dx, dy));
}

/** Returns a new document model with `fix` applied (the input is not mutated). */
function applyFixToModel(doc, fix) {
  const next = cloneDoc(doc);
  const found = [...walk(next.layers)].find((i) => i.layer.id === fix.layerId);
  if (!found) return next;
  const l = found.layer;
  switch (fix.type) {
    case 'setColor':
      if (l.text) l.text.colorHex = fix.hex;
      else l.fillHex = fix.hex;
      break;
    case 'setFont':
      if (l.text) l.text.font = fix.font;
      break;
    case 'setSize':
      if (l.text && l.bounds && l.text.sizePx) {
        const k = fix.sizePx / l.text.sizePx;
        l.bounds.right = l.bounds.left + w(l.bounds) * k;
        l.bounds.bottom = l.bounds.top + h(l.bounds) * k;
        l.text.sizePx = fix.sizePx;
      }
      break;
    case 'moveBy':
      translate(l, fix.dx, fix.dy);
      break;
    case 'rename':
      l.name = fix.name;
      break;
    case 'delete': {
      const list = found.parent ? found.parent.children : next.layers;
      list.splice(list.indexOf(l), 1);
      break;
    }
    default:
  }
  return next;
}

/**
 * Pick fixes for "Fix all": safe ones only, at most one fix of each type per layer, with
 * size changes ordered before moves so the nudge is computed on final bounds by the next pass.
 */
function selectSafeFixes(findings) {
  const rank = { setFont: 0, setSize: 1, setColor: 2, rename: 3, moveBy: 4 };
  const seen = new Set();
  const out = [];
  for (const f of findings) {
    if (!f.fix || f.fix.safe === false) continue;
    const key = `${f.fix.type}:${f.fix.layerId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f.fix);
  }
  return out.sort((a, b) => (rank[a.type] ?? 9) - (rank[b.type] ?? 9));
}

module.exports = { audit, summarize, applyFixToModel, selectSafeFixes, fontAllowed };
