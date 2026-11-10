'use strict';
// Variant engine: re-lays out a design for another canvas size.
//
// Three strategies produce *plans* (pure data: where every layer goes). Every plan is scored by
// the same audit rules, and the best one wins (or the user overrides per format):
//
//   fit     Scales the WHOLE design uniformly and centres it. Nothing is cropped, nothing is
//           rearranged — it is the same design, just smaller or larger. Backgrounds are
//           extended to fill the new canvas. Always safe; may leave wide margins when the
//           aspect ratio changes a lot.
//   anchor  Keeps each layer pinned to the edge it was nearest to (left/right/top/bottom or
//           centre) with margins scaled, so the layout uses the new canvas better.
//   ai      A layout proposed by Claude from a picture of the design (see ai.js), validated and
//           repaired here: unknown layers are kept, backgrounds are forced to cover, content is
//           pulled back inside the safe zone.
//
// Shared guardrails: layers that overlap heavily in the source (a button and its label) form a
// *cluster* that always moves as one; clusters are clamped into the safe zone and stacked apart
// again if the clamp made them collide.

const { inferRoles, hasBounds, w, h, area, intersectionArea, SAFE_ROLES } = require('./roles');
const { safeRect } = require('./spec');
const { audit } = require('./rules');

const TEXTY = new Set(['headline', 'body', 'cta', 'logo']);
const LAYOUT_RULES = ['safe-zone', 'min-text', 'contrast'];

function union(layers) {
  if (!layers.length) return null;
  return layers.reduce(
    (u, l) => ({
      left: Math.min(u.left, l.bounds.left), top: Math.min(u.top, l.bounds.top),
      right: Math.max(u.right, l.bounds.right), bottom: Math.max(u.bottom, l.bounds.bottom),
    }),
    { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
  );
}

/** 'start' | 'center' | 'end' from the margins on either side. */
function anchorOf(before, after, total) {
  if (Math.abs(before - after) < 0.15 * total) return 'center';
  return before < after ? 'start' : 'end';
}

// ---- clusters -----------------------------------------------------------------------------

function bbox(rects) {
  return rects.reduce(
    (u, r) => ({
      left: Math.min(u.left, r.left), top: Math.min(u.top, r.top),
      right: Math.max(u.right, r.right), bottom: Math.max(u.bottom, r.bottom),
    }),
    { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
  );
}

/** Shift needed to bring [lo, hi] inside [a, b]; centres it when it is larger than the room. */
function fitShift(lo, hi, a, b) {
  if (hi - lo > b - a) return (a + b) / 2 - (lo + hi) / 2;
  if (lo < a) return a - lo;
  if (hi > b) return b - hi;
  return 0;
}

function shift(c, dx, dy) {
  for (const p of c.members) {
    p.to.left += dx; p.to.right += dx; p.to.top += dy; p.to.bottom += dy;
  }
  c.to = bbox(c.members.map((p) => p.to));
}

function resolveClusters(placements, doc, safe, s) {
  const canvas = doc.width * doc.height;
  const cand = placements.filter((p) => !p._free && !(['graphic', 'group'].includes(p.role) && area(p.from) / canvas > 0.25));

  // union-find over heavy source overlaps
  const parent = cand.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < cand.length; i++) {
    for (let j = i + 1; j < cand.length; j++) {
      const small = Math.max(1, Math.min(area(cand[i].from), area(cand[j].from)));
      if (intersectionArea(cand[i].from, cand[j].from) / small >= 0.5) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  cand.forEach((p, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(p);
  });
  const clusters = [...groups.values()]
    .filter((members) => members.some((p) => p._clampable))
    .map((members) => {
      const from = bbox(members.map((p) => p.from));
      return {
        members, from, to: bbox(members.map((p) => p.to)),
        bottomAnchored: anchorOf(from.top, doc.height - from.bottom, doc.height) === 'end',
      };
    });

  const clampAll = () => {
    for (const c of clusters) {
      shift(c, fitShift(c.to.left, c.to.right, safe.left, safe.right), fitShift(c.to.top, c.to.bottom, safe.top, safe.bottom));
    }
  };
  clampAll();

  // Stack apart clusters that the clamp pushed into each other. Order = source top-to-bottom.
  const ordered = [...clusters].sort((a, b) => a.from.top - b.from.top);
  const xOverlap = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0;
  const gapOf = (a, c) => Math.max(0, c.from.top - a.from.bottom) * s * 0.5;
  for (let pass = 0; pass < 2; pass++) {
    // top-to-bottom: lower, non-bottom-anchored clusters yield downwards
    for (let i = 0; i < ordered.length; i++) {
      for (let j = i + 1; j < ordered.length; j++) {
        const a = ordered[i];
        const c = ordered[j];
        if (c.bottomAnchored || a.from.bottom > c.from.top + 1 || !xOverlap(a.from, c.from)) continue;
        const need = a.to.bottom + gapOf(a, c) - c.to.top;
        if (need > 0.5) shift(c, 0, need);
      }
    }
    // bottom-to-top: bottom-anchored clusters push the ones above them upwards
    for (let j = ordered.length - 1; j >= 0; j--) {
      for (let i = j - 1; i >= 0; i--) {
        const a = ordered[i];
        const c = ordered[j];
        if (!c.bottomAnchored || a.from.bottom > c.from.top + 1 || !xOverlap(a.from, c.from)) continue;
        const need = a.to.bottom + gapOf(a, c) - c.to.top;
        if (need > 0.5) shift(a, 0, -need);
      }
    }
    clampAll();
  }
}

// ---- shared placement helpers --------------------------------------------------------------

/** Backgrounds always cover the whole canvas: photos are scaled to cover, fills are stretched. */
function placeBackground(l, tw, th) {
  const b = l.bounds;
  const lw = w(b);
  const lh = h(b);
  if (l.kind === 'pixel' || l.kind === 'smart') {
    const k = Math.max(tw / lw, th / lh);
    const nw = lw * k;
    const nh = lh * k;
    const x = (tw - nw) / 2;
    const y = (th - nh) / 2;
    return { to: { left: x, top: y, right: x + nw, bottom: y + nh }, sx: k, sy: k };
  }
  return { to: { left: 0, top: 0, right: tw, bottom: th }, sx: tw / lw, sy: th / lh };
}

function makePlacement(l, role, to, sx, sy, flags) {
  return {
    layerId: l.id, name: l.name, role, kind: l.kind,
    from: { ...l.bounds },
    to,
    scaleX: sx, scaleY: sy,
    fontScale: l.kind === 'text' ? Math.min(sx, sy) : undefined,
    _clampable: !!(flags && flags.clampable),
    _free: !!(flags && flags.free),
  };
}

function finishPlan(doc, format, spec, placements, mode, label, s) {
  const safe = safeRect(format.width, format.height, spec, format);
  resolveClusters(placements, doc, safe, s);
  for (const p of placements) { delete p._clampable; delete p._free; }

  const warnings = [];
  // Warn about collisions that did not exist in the source design.
  const texty = placements.filter((p) => TEXTY.has(p.role));
  for (let i = 0; i < texty.length; i++) {
    for (let j = i + 1; j < texty.length; j++) {
      const a = texty[i];
      const c = texty[j];
      const small = Math.max(1, Math.min(area(a.to), area(c.to)));
      const smallSrc = Math.max(1, Math.min(area(a.from), area(c.from)));
      if (intersectionArea(a.to, c.to) / small > 0.1 && intersectionArea(a.from, c.from) / smallSrc < 0.05) {
        warnings.push({ kind: 'overlap', message: `"${a.name}" now overlaps "${c.name}".` });
      }
    }
  }
  if (s < 0.45) {
    warnings.push({
      kind: 'extreme-scale',
      message: `Content shrinks to ${Math.round(s * 100)}% — this aspect ratio probably needs its own layout.`,
    });
  }
  return { format, mode, label, scale: s, placements, warnings };
}

const visibleLayers = (doc) => doc.layers.filter((l) => l.visible && hasBounds(l));

// ---- strategy 1: fit — same design, uniformly scaled, nothing cropped -----------------------

function planFit(doc, format, spec) {
  const roles = inferRoles(doc);
  const sw = doc.width;
  const sh = doc.height;
  const tw = format.width;
  const th = format.height;
  const s = Math.min(tw / sw, th / sh);
  const ox = (tw - sw * s) / 2;
  const oy = (th - sh * s) / 2;

  const placements = visibleLayers(doc).map((l) => {
    const role = roles[l.id];
    if (role === 'background') {
      const bg = placeBackground(l, tw, th);
      return makePlacement(l, role, bg.to, bg.sx, bg.sy, { free: true });
    }
    const b = l.bounds;
    const to = { left: ox + b.left * s, top: oy + b.top * s, right: ox + b.right * s, bottom: oy + b.bottom * s };
    return makePlacement(l, role, to, s, s, { clampable: SAFE_ROLES.has(role), free: role === 'image' });
  });
  return finishPlan(doc, format, spec, placements, 'fit', 'Same design, scaled to fit', s);
}

// ---- strategy 2: anchor — keep edges, use the new canvas better -----------------------------

function planAnchor(doc, format, spec) {
  const roles = inferRoles(doc);
  const sw = doc.width;
  const sh = doc.height;
  const tw = format.width;
  const th = format.height;
  const safe = safeRect(tw, th, spec, format);
  const safeW = safe.right - safe.left;
  const safeH = safe.bottom - safe.top;
  const layers = visibleLayers(doc);

  const block = union(layers.filter((l) => !['background', 'image'].includes(roles[l.id])));
  let s = Math.min(tw, th) / Math.min(sw, sh);
  if (block) s = Math.min(s, safeW / Math.max(1, w(block)), safeH / Math.max(1, h(block)));

  const placements = [];
  for (const l of layers) {
    const role = roles[l.id];
    const b = l.bounds;
    if (role === 'background') {
      const bg = placeBackground(l, tw, th);
      placements.push(makePlacement(l, role, bg.to, bg.sx, bg.sy, { free: true }));
      continue;
    }
    const lw = w(b);
    const lh = h(b);
    let ls = s;
    let nw = lw * ls;
    let nh = lh * ls;
    let sx = ls;
    let sy = ls;
    let stretched = false;

    const ml = b.left;
    const mr = sw - b.right;
    const mt = b.top;
    const mb = sh - b.bottom;
    const ax = anchorOf(ml, mr, sw);
    const ay = anchorOf(mt, mb, sh);

    const stretchable = role === 'graphic' && (l.kind === 'shape' || l.kind === 'solid');
    if (stretchable && lw / sw >= 0.8) { nw = Math.max(1, tw - (ml + mr) * s); sx = nw / lw; stretched = true; }
    if (stretchable && lh / sh >= 0.8) { nh = Math.max(1, th - (mt + mb) * s); sy = nh / lh; stretched = true; }
    if (role === 'image' && lw / sw >= 0.8) { ls = tw / sw; nw = lw * ls; nh = lh * ls; sx = sy = ls; }

    // A layer that was fully inside the source canvas must stay fully inside the target.
    const srcInside = b.left >= -1 && b.top >= -1 && b.right <= sw + 1 && b.bottom <= sh + 1;
    if (srcInside) {
      const k = Math.min(1, tw / nw, th / nh);
      if (k < 1) { nw *= k; nh *= k; sx *= k; sy *= k; ls *= k; }
    }

    const fits = nw <= safeW + 0.5 && nh <= safeH + 0.5;
    const clampable = SAFE_ROLES.has(role) || (role === 'group' && fits);
    if (clampable) {
      const k = Math.min(1, safeW / nw, safeH / nh);
      if (k < 1) { nw *= k; nh *= k; sx *= k; sy *= k; ls *= k; }
    }

    const cx = (b.left + b.right) / 2;
    const cy = (b.top + b.bottom) / 2;
    let x = ax === 'start' ? ml * s : ax === 'end' ? tw - mr * s - nw : tw / 2 + (cx - sw / 2) * s - nw / 2;
    let y = ay === 'start' ? mt * s : ay === 'end' ? th - mb * s - nh : th / 2 + (cy - sh / 2) * s - nh / 2;
    if (srcInside) {
      x = Math.min(Math.max(x, 0), Math.max(0, tw - nw));
      y = Math.min(Math.max(y, 0), Math.max(0, th - nh));
    }
    placements.push(makePlacement(l, role, { left: x, top: y, right: x + nw, bottom: y + nh }, sx, sy,
      { clampable, free: stretched || role === 'image' }));
  }
  return finishPlan(doc, format, spec, placements, 'anchor', 'Edges kept, margins scaled', s);
}

// ---- applying + scoring --------------------------------------------------------------------

function mapBounds(b, from, to, sx, sy) {
  return {
    left: to.left + (b.left - from.left) * sx,
    right: to.left + (b.right - from.left) * sx,
    top: to.top + (b.top - from.top) * sy,
    bottom: to.top + (b.bottom - from.top) * sy,
  };
}

function transformLayer(layer, p) {
  if (layer.bounds) layer.bounds = mapBounds(layer.bounds, p.from, p.to, p.scaleX, p.scaleY);
  if (layer.text && p.fontScale) layer.text.sizePx = layer.text.sizePx * p.fontScale;
  (layer.children || []).forEach((c) => transformLayer(c, p));
}

/** The document model as it would look after the plan is carried out. */
function applyPlan(doc, plan) {
  const next = JSON.parse(JSON.stringify(doc));
  next.width = plan.format.width;
  next.height = plan.format.height;
  next.name = `${doc.name} – ${plan.format.id}`;
  const byId = new Map(plan.placements.map((p) => [p.layerId, p]));
  for (const l of next.layers) {
    const p = byId.get(l.id);
    if (p) transformLayer(l, p);
  }
  return next;
}

/**
 * Higher is better. Cut-off content is punished hardest (the "only part of my design" failure),
 * then preflight problems and collisions; using more of the canvas earns a bonus.
 */
function scorePlan(doc, plan, spec, findings) {
  const { width: tw, height: th } = plan.format;
  const canvas = { left: 0, top: 0, right: tw, bottom: th };
  const notes = [];
  let penalty = 0;
  const content = plan.placements.filter((p) => p.role !== 'background');

  for (const p of content) {
    const a = Math.max(1, area(p.to));
    const frac = intersectionArea(p.to, canvas) / a;
    if (frac < 0.97) {
      penalty += (1 - frac) * 60;
      notes.push(`${p.name} is cut off`);
    }
  }
  for (const f of findings) penalty += f.rule === 'min-text' ? 8 : 4;
  penalty += plan.warnings.filter((x) => x.kind === 'overlap').length * 8;

  let bonus = 0;
  if (content.length) {
    const box = bbox(content.map((p) => p.to));
    const safe = safeRect(tw, th, spec, plan.format);
    const safeArea = Math.max(1, (safe.right - safe.left) * (safe.bottom - safe.top));
    bonus = 20 * Math.min(1, (Math.max(0, box.right - box.left) * Math.max(0, box.bottom - box.top)) / (safeArea * 0.7));
  }
  return { score: Math.round((100 - penalty + bonus) * 10) / 10, notes };
}

/** Evaluate any plan: simulate it, audit it, score it. */
function evaluatePlan(doc, plan, spec) {
  const result = applyPlan(doc, plan);
  const findings = audit(result, spec, { format: plan.format, hygiene: false })
    // Colour/font problems are inherited from the source, not caused by the resize.
    .filter((f) => LAYOUT_RULES.includes(f.rule));
  const { score, notes } = scorePlan(doc, plan, spec, findings);
  return { plan, result, findings, warnings: plan.warnings, score, notes, mode: plan.mode, label: plan.label };
}

/**
 * All candidate layouts for a format. `opts.aiPlan` adds the AI candidate.
 * `best` is the highest score; ties go to `ai`, then `fit` (the guaranteed-complete one).
 */
function previewVariant(doc, format, spec, opts) {
  const candidates = {
    fit: evaluatePlan(doc, planFit(doc, format, spec), spec),
    anchor: evaluatePlan(doc, planAnchor(doc, format, spec), spec),
  };
  if (opts && opts.aiPlan) candidates.ai = evaluatePlan(doc, opts.aiPlan, spec);

  const order = ['ai', 'fit', 'anchor'].filter((k) => candidates[k]);
  let best = order[0];
  for (const k of order) if (candidates[k].score > candidates[best].score + 0.5) best = k;
  return { candidates, best, ...candidates[best] };
}

module.exports = {
  planFit, planAnchor, planVariant: planAnchor, applyPlan, evaluatePlan, previewVariant, scorePlan,
  // used by ai.js
  _internal: { placeBackground, makePlacement, finishPlan, visibleLayers, SAFE_ROLES },
};
