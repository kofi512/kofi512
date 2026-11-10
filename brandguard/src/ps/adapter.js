'use strict';
// Photoshop (UXP) adapter — the only file that talks to the Photoshop DOM.
//
// Contract (mirrored by dev/mock-adapter.js):
//   readDocument()                  -> document model | null        (see src/core/roles.js)
//   selectLayer(id)                 -> Promise
//   applyFixes(fixes, historyName)  -> { applied, failed: [{ fix, error }] }   one undo step
//   createVariant(plan, {exportFolder}) -> { name }
//   reactivateSource()              -> Promise
//   pickFolder()                    -> folder | null
//   loadSpec() / saveSpec(spec)     -> localStorage
//   importSpecFile() / exportSpecFile(spec)
//   onDocumentChange(cb)            -> unsubscribe
//
// Layer ids are index paths ("0", "2.1") so they stay valid across duplicated documents.
// NOTE: written against the Photoshop 24.2+ UXP DOM. It could not be executed in the cloud
// build environment — load it with Adobe's UXP Developer Tool and report anything that throws.

const photoshop = require('photoshop');
const uxp = require('uxp');

const { app, core, action, constants } = photoshop;
const fs = uxp.storage.localFileSystem;
const SPEC_KEY = 'brandguard.spec.v1';

let sourceDoc = null; // the Photoshop Document the model was last read from

// ------------------------------------------------------------------ reading

const KIND = {
  text: 'text', pixel: 'pixel', smartobject: 'smart', solidcolor: 'solid', group: 'group',
  shape: 'shape', vector: 'shape', gradientfill: 'other', patternfill: 'other',
};

function kindOf(layer) {
  const k = String(layer.kind || '').toLowerCase();
  if (KIND[k]) return KIND[k];
  if (/adjust|curves|levels|hue|brightness|exposure|vibrance|balance|mixer|lookup|threshold|posterize|invert|photofilter|gradientmap|selectivecolor|blackandwhite/.test(k)) return 'adjustment';
  return 'other';
}

function modeOf(doc) {
  const m = String(doc.mode || '').toUpperCase();
  if (m.includes('CMYK')) return 'CMYK';
  if (m.includes('GRAY')) return 'Grayscale';
  if (m.includes('RGB')) return 'RGB';
  return m;
}

const hex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

async function solidFillHex(layer) {
  try {
    const [res] = await action.batchPlay([{ _obj: 'get', _target: [{ _ref: 'layer', _id: layer.id }] }], {});
    const c = res && res.adjustment && res.adjustment[0] && res.adjustment[0].color;
    if (c && c.red !== undefined) return `#${hex2(c.red)}${hex2(c.grain !== undefined ? c.grain : c.green)}${hex2(c.blue)}`.toUpperCase();
  } catch (e) { /* not a solid layer */ }
  return undefined;
}

async function readLayer(layer, path, resolution) {
  const kind = kindOf(layer);
  const b = layer.bounds;
  const bounds = b && b.right > b.left && b.bottom > b.top
    ? { left: b.left, top: b.top, right: b.right, bottom: b.bottom }
    : null;
  const out = {
    id: path,
    name: layer.name,
    kind,
    visible: layer.visible,
    locked: !!layer.allLocked,
    opacity: layer.opacity,
    empty: kind === 'pixel' && !bounds,
    bounds,
  };
  if (kind === 'text') {
    try {
      const ti = layer.textItem;
      const cs = ti.characterStyle;
      // Photoshop reports size in points; convert to pixels at the document resolution.
      out.text = {
        content: ti.contents,
        font: cs.font,
        sizePx: cs.size * (resolution / 72),
        colorHex: cs.color && cs.color.rgb ? `#${cs.color.rgb.hexValue}`.toUpperCase() : undefined,
      };
    } catch (e) { out.kind = 'other'; }
  } else if (kind === 'solid') {
    out.fillHex = await solidFillHex(layer);
  } else if (kind === 'group') {
    out.children = [];
    const kids = layer.layers || [];
    for (let i = 0; i < kids.length; i++) out.children.push(await readLayer(kids[i], `${path}.${i}`, resolution));
  }
  return out;
}

async function readDocument() {
  const doc = app.activeDocument;
  if (!doc) { sourceDoc = null; return null; }
  sourceDoc = doc;
  const layers = [];
  for (let i = 0; i < doc.layers.length; i++) layers.push(await readLayer(doc.layers[i], String(i), doc.resolution));
  return {
    name: doc.name,
    width: Math.round(doc.width),
    height: Math.round(doc.height),
    resolution: doc.resolution,
    colorMode: modeOf(doc),
    layers,
  };
}

// ------------------------------------------------------------------ locating layers

function findLayer(doc, path) {
  const idx = String(path).split('.').map(Number);
  let list = doc.layers;
  let layer = null;
  for (const i of idx) {
    layer = list && list[i];
    if (!layer) return null;
    list = layer.layers;
  }
  return layer;
}

async function selectLayer(path) {
  const doc = sourceDoc || app.activeDocument;
  const layer = doc && findLayer(doc, path);
  if (!layer) throw new Error('Layer not found — rescan the document.');
  await core.executeAsModal(async () => {
    doc.activeLayers = [layer];
  }, { commandName: 'BrandGuard: select layer' });
}

// ------------------------------------------------------------------ fixes

function solidColor(hex) {
  const c = new app.SolidColor();
  c.rgb.hexValue = hex.replace('#', '');
  return c;
}

async function setSolidLayerColor(doc, layer, hex) {
  doc.activeLayers = [layer];
  const n = parseInt(hex.slice(1), 16);
  await action.batchPlay([{
    _obj: 'set',
    _target: [{ _ref: 'contentLayer', _enum: 'ordinal', _value: 'targetEnum' }],
    to: { _obj: 'solidColorLayer', color: { _obj: 'RGBColor', red: (n >> 16) & 255, grain: (n >> 8) & 255, blue: n & 255 } },
  }], {});
}

async function runFix(doc, fix) {
  const layer = findLayer(doc, fix.layerId);
  if (!layer) throw new Error(`layer ${fix.layerId} not found`);
  const res = doc.resolution / 72;
  switch (fix.type) {
    case 'setFont': layer.textItem.characterStyle.font = fix.font; break;
    case 'setSize': layer.textItem.characterStyle.size = fix.sizePx / res; break;
    case 'setColor':
      if (kindOf(layer) === 'text') layer.textItem.characterStyle.color = solidColor(fix.hex);
      else await setSolidLayerColor(doc, layer, fix.hex);
      break;
    case 'moveBy': layer.translate(fix.dx, fix.dy); break;
    case 'rename': layer.name = fix.name; break;
    case 'delete': layer.delete(); break;
    default: throw new Error(`unknown fix ${fix.type}`);
  }
}

async function applyFixes(fixes, historyName) {
  const doc = sourceDoc || app.activeDocument;
  if (!doc) throw new Error('No document open.');
  const failed = [];
  let applied = 0;
  // Deletes last and bottom-up so index paths of the remaining fixes stay valid.
  const ordered = [...fixes].sort((a, b) => (a.type === 'delete') - (b.type === 'delete')
    || (a.type === 'delete' ? String(b.layerId).localeCompare(String(a.layerId), undefined, { numeric: true }) : 0));
  await core.executeAsModal(async () => {
    for (const fix of ordered) {
      try { await runFix(doc, fix); applied++; } catch (e) { failed.push({ fix, error: (e && e.message) || String(e) }); }
    }
  }, { commandName: historyName || 'BrandGuard fixes', historyStateInfo: { name: historyName || 'BrandGuard fixes', target: doc } });
  return { applied, failed };
}

// ------------------------------------------------------------------ variants

async function createVariant(plan, opts) {
  const src = sourceDoc;
  if (!src) throw new Error('No source document.');
  const { format } = plan;
  let name = `${src.name.replace(/\.[^.]+$/, '')} – ${format.id}`;

  await core.executeAsModal(async () => {
    const dup = await src.duplicate(name);
    await dup.resizeCanvas(format.width, format.height, constants.AnchorPosition.TOPLEFT);

    for (const p of plan.placements) {
      const layer = findLayer(dup, p.layerId);
      if (!layer) continue;
      const isText = p.kind === 'text' && p.fontScale;
      if (isText) {
        const cs = layer.textItem.characterStyle;
        cs.size = cs.size * p.fontScale;
      } else {
        const sx = p.scaleX * 100;
        const sy = p.scaleY * 100;
        if (Math.abs(sx - 100) > 0.01 || Math.abs(sy - 100) > 0.01) {
          await layer.scale(sx, sy, constants.AnchorPosition.TOPLEFT);
        }
      }
      // Re-read bounds and translate so the top-left lands exactly on the planned spot.
      const b = layer.bounds;
      await layer.translate(p.to.left - b.left, p.to.top - b.top);
    }

    if (opts && opts.exportFolder) {
      const file = await opts.exportFolder.createFile(`${name}.png`, { overwrite: true });
      await dup.saveAs.png(file, { compression: 6 }, true);
    }
    name = dup.name;
  }, { commandName: `BrandGuard: ${format.name}` });

  return { name };
}

async function reactivateSource() {
  if (!sourceDoc) return;
  try {
    await core.executeAsModal(async () => { app.activeDocument = sourceDoc; }, { commandName: 'BrandGuard: back to source' });
  } catch (e) { /* source may have been closed */ }
}

async function pickFolder() {
  try { return await fs.getFolder(); } catch (e) { return null; }
}

// ------------------------------------------------------------------ brand spec storage

async function loadSpec() {
  try {
    const raw = window.localStorage.getItem(SPEC_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

async function saveSpec(spec) {
  try { window.localStorage.setItem(SPEC_KEY, JSON.stringify(spec)); } catch (e) { /* ignore */ }
}

async function importSpecFile() {
  const file = await fs.getFileForOpening({ types: ['json'] });
  if (!file) return null;
  return JSON.parse(await file.read());
}

async function exportSpecFile(spec) {
  const file = await fs.getFileForSaving('brand-spec.json', { types: ['json'] });
  if (!file) return false;
  await file.write(JSON.stringify(spec, null, 2));
  return true;
}

// ------------------------------------------------------------------ change notifications

function onDocumentChange(cb) {
  const events = [{ event: 'select' }, { event: 'open' }, { event: 'close' }, { event: 'save' }];
  let timer = null;
  const handler = () => { clearTimeout(timer); timer = setTimeout(cb, 250); };
  try { action.addNotificationListener(events, handler); } catch (e) { return () => {}; }
  return () => { try { action.removeNotificationListener(events, handler); } catch (e) { /* ignore */ } };
}

module.exports = {
  readDocument, selectLayer, applyFixes, createVariant, reactivateSource, pickFolder,
  loadSpec, saveSpec, importSpecFile, exportSpecFile, onDocumentChange,
};
