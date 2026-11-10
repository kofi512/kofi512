'use strict';
// Document model helpers + role inference.
//
// Document model (what the Photoshop adapter produces, and what everything in core consumes):
//   { name, width, height, resolution, colorMode: 'RGB'|'CMYK'|'Grayscale',
//     layers: Layer[] }              // top-most layer first
//   Layer = { id, name, kind, visible, locked, opacity, empty,
//             bounds: {left, top, right, bottom} | null,
//             text?: { content, font, sizePx, colorHex },
//             fillHex?: string,           // solid-colour layers
//             children?: Layer[] }        // groups
//   kind: 'text' | 'pixel' | 'smart' | 'shape' | 'solid' | 'group' | 'adjustment' | 'other'

const w = (b) => b.right - b.left;
const h = (b) => b.bottom - b.top;
const area = (b) => Math.max(0, w(b)) * Math.max(0, h(b));

function* walk(layers, parent) {
  for (const l of layers || []) {
    yield { layer: l, parent: parent || null };
    if (l.children) yield* walk(l.children, l);
  }
}

function intersectionArea(a, b) {
  const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return x > 0 && y > 0 ? x * y : 0;
}

function hasBounds(l) {
  return !!l.bounds && w(l.bounds) > 0 && h(l.bounds) > 0;
}

/**
 * Infer a design role for every top-level layer: background | logo | headline | body | cta
 * | image | graphic | group. Layer names win; geometry and text size are the fallback.
 * Returns { [layerId]: role }.
 */
function inferRoles(doc) {
  const roles = {};
  const canvas = doc.width * doc.height;
  const top = doc.layers.filter((l) => hasBounds(l));

  let biggestText = null;
  for (const l of top) {
    if (l.kind === 'text' && l.text && (!biggestText || l.text.sizePx > biggestText.text.sizePx)) biggestText = l;
  }

  for (const l of top) {
    const name = (l.name || '').toLowerCase();
    const covers = area(l.bounds) / canvas;
    if (/\b(bg|background)\b/.test(name) || (covers >= 0.9 && l.kind !== 'text' && l.kind !== 'group')) {
      roles[l.id] = 'background';
    } else if (/logo|wordmark|brandmark/.test(name)) {
      roles[l.id] = 'logo';
    } else if (/\b(cta|button|btn)\b/.test(name)) {
      roles[l.id] = 'cta';
    } else if (l.kind === 'text') {
      roles[l.id] = /\b(head(line)?|title)\b/.test(name) || l === biggestText ? 'headline' : 'body';
    } else if (l.kind === 'group') {
      roles[l.id] = 'group';
    } else if ((l.kind === 'pixel' || l.kind === 'smart') && covers > 0.15) {
      roles[l.id] = 'image';
    } else {
      roles[l.id] = 'graphic';
    }
  }
  return roles;
}

/** Roles that must stay inside the safe zone. */
const SAFE_ROLES = new Set(['headline', 'body', 'cta', 'logo']);

module.exports = { walk, w, h, area, intersectionArea, hasBounds, inferRoles, SAFE_ROLES };
