'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const color = require('../src/core/color');
const { normalizeSpec, DEFAULT_SPEC, safeRect } = require('../src/core/spec');
const { inferRoles } = require('../src/core/roles');
const { audit, summarize, applyFixToModel, selectSafeFixes, fontAllowed } = require('../src/core/rules');
const { planVariant, applyPlan, previewVariant } = require('../src/core/variants');
const { sampleDoc } = require('../dev/sample-doc');

const spec = normalizeSpec(DEFAULT_SPEC).spec;
const rules = (findings) => findings.map((f) => f.rule);
const byRule = (findings, rule) => findings.filter((f) => f.rule === rule);

test('color: hex parsing, contrast and delta-E', () => {
  assert.equal(color.normHex('abc'), '#AABBCC');
  assert.equal(color.normHex('#12345'), null);
  assert.equal(color.contrastRatio('#000000', '#FFFFFF').toFixed(1), '21.0');
  assert.ok(color.deltaE('#E4572E', '#E4572F') < 1);
  assert.ok(color.deltaE('#E4572E', '#2E57E4') > 40);
});

test('spec: normalisation drops bad data but keeps the rest usable', () => {
  const { spec: s, errors } = normalizeSpec({
    palette: [{ name: 'ok', hex: '#fff' }, { name: 'bad', hex: 'nope' }, { hex: '#FFFFFF' }],
    formats: [{ name: 'tiny', width: 3, height: 3 }, { name: 'Wide', width: 800, height: 200 }],
    safeMarginPct: 999,
  });
  assert.deepEqual(s.palette, [{ name: 'ok', hex: '#FFFFFF' }]);
  assert.equal(s.formats.length, 1);
  assert.equal(s.safeMarginPct, 25);
  assert.equal(errors.length, 2);
  assert.ok(normalizeSpec(null).spec.palette.length > 0);
});

test('spec: story format keeps platform UI zones clear', () => {
  const story = DEFAULT_SPEC.formats.find((f) => f.id === 'story');
  const r = safeRect(1080, 1920, spec, story);
  assert.equal(Math.round(r.top), Math.round(1920 * 0.14));
  assert.equal(Math.round(1920 - r.bottom), Math.round(1920 * 0.2));
});

test('roles are inferred from names, geometry and text size', () => {
  const r = inferRoles(sampleDoc());
  assert.equal(r['9'], 'background');
  assert.equal(r['5'], 'logo');
  assert.equal(r['2'], 'headline');
  assert.equal(r['3'], 'body');
  assert.equal(r['1'], 'cta');
  assert.equal(r['6'], 'image');
});

test('font matching accepts families and PostScript suffixes', () => {
  assert.ok(fontAllowed('Montserrat-ExtraBold', ['Montserrat']));
  assert.ok(fontAllowed('Inter Regular', ['inter']));
  assert.ok(!fontAllowed('Comic Sans MS', ['Montserrat', 'Inter']));
});

test('audit flags the planted problems in the sample document', () => {
  const f = audit(sampleDoc(), spec);
  assert.equal(byRule(f, 'font').length, 1);
  assert.equal(byRule(f, 'font')[0].layerName, 'Subhead');
  assert.equal(byRule(f, 'font')[0].severity, 'error');
  assert.equal(byRule(f, 'min-text')[0].layerName, 'Fine print');
  assert.deepEqual(byRule(f, 'safe-zone').map((x) => x.layerName).sort(), ['Fine print', 'Logo']);
  assert.deepEqual(byRule(f, 'contrast').map((x) => x.layerName).sort(), ['Fine print', 'Shop now', 'Subhead']);
  assert.ok(byRule(f, 'palette').some((x) => x.layerName === 'Background' && x.severity === 'warn'));
  assert.ok(byRule(f, 'palette').some((x) => x.layerName === 'Subhead' && x.severity === 'info'));
  assert.deepEqual(byRule(f, 'empty-layer').map((x) => x.layerName), ['Layer 14']);
  assert.deepEqual(byRule(f, 'hidden-layer').map((x) => x.layerName), ['Old headline']);
  assert.equal(byRule(f, 'default-name').length, 1);
  // Findings are ordered errors first.
  assert.equal(f[0].severity, 'error');
});

test('contrast: white text on the cream background is caught and fixed from the palette', () => {
  const doc = sampleDoc();
  doc.layers.push({
    id: '10', name: 'Light copy', kind: 'text', visible: true, bounds: { left: 90, top: 300, right: 400, bottom: 340 },
    text: { content: 'x', font: 'Inter', sizePx: 36, colorHex: '#FFFFFF' },
  });
  // Insert above the background (index order = z-order, top first).
  doc.layers.splice(2, 0, doc.layers.pop());
  const f = byRule(audit(doc, spec), 'contrast').filter((x) => x.layerName === 'Light copy');
  assert.equal(f.length, 1);
  assert.equal(f[0].fix.type, 'setColor');
  assert.equal(f[0].fix.hex, '#111111'); // the palette colour closest to white that passes
});

test('fixes can be replayed on the model and clear the finding', () => {
  let doc = sampleDoc();
  for (const rule of ['font', 'min-text', 'contrast', 'safe-zone']) {
    for (const found of byRule(audit(doc, spec), rule)) doc = applyFixToModel(doc, found.fix);
    assert.equal(byRule(audit(doc, spec), rule).length, 0, `${rule} should be resolved`);
  }
});

test('"fix all" only selects safe fixes, one per type per layer', () => {
  const fixes = selectSafeFixes(audit(sampleDoc(), spec));
  assert.ok(fixes.length > 0);
  assert.ok(fixes.every((x) => x.safe !== false));
  assert.ok(!fixes.some((x) => x.type === 'delete'));
  const keys = fixes.map((x) => `${x.type}:${x.layerId}`);
  assert.equal(new Set(keys).size, keys.length);
  // Repeated rounds reach a fixed point with no safe fixes left.
  let doc = sampleDoc();
  for (let i = 0; i < 4; i++) {
    const batch = selectSafeFixes(audit(doc, spec));
    const nonMove = batch.filter((x) => x.type !== 'moveBy');
    for (const fx of nonMove.length ? nonMove : batch) doc = applyFixToModel(doc, fx);
  }
  assert.equal(selectSafeFixes(audit(doc, spec)).length, 0);
});

test('delete fix removes the layer', () => {
  const doc = sampleDoc();
  const hidden = byRule(audit(doc, spec), 'hidden-layer')[0];
  const next = applyFixToModel(doc, hidden.fix);
  assert.equal(next.layers.length, doc.layers.length - 1);
  assert.equal(doc.layers.length, 10, 'input must not be mutated');
});

function cleanDoc() {
  return {
    name: 'clean', width: 1000, height: 1000, resolution: 72, colorMode: 'RGB',
    layers: [
      { id: '0', name: 'Headline', kind: 'text', visible: true, bounds: { left: 100, top: 100, right: 700, bottom: 220 },
        text: { content: 'Hi', font: 'Montserrat-Bold', sizePx: 90, colorHex: '#111111' } },
      { id: '1', name: 'Background', kind: 'solid', visible: true, fillHex: '#FFFFFF', bounds: { left: 0, top: 0, right: 1000, bottom: 1000 } },
    ],
  };
}

test('clean document produces no findings', () => {
  assert.deepEqual(audit(cleanDoc(), spec), []);
});

// ---- variants ---------------------------------------------------------------------------

test('variant: identity plan leaves a clean design in place', () => {
  const doc = cleanDoc();
  const fmt = { id: 'same', name: 'same', width: doc.width, height: doc.height };
  const plan = planVariant(doc, fmt, spec);
  const head = plan.placements.find((p) => p.name === 'Headline');
  assert.ok(Math.abs(head.to.left - head.from.left) < 1.5 && Math.abs(head.to.top - head.from.top) < 1.5);
  assert.ok(Math.abs(plan.scale - 1) < 1e-9);
});

test('variant: background covers the canvas and nothing escapes the safe zone', () => {
  const doc = sampleDoc();
  for (const fmt of spec.formats) {
    const { plan } = previewVariant(doc, fmt, spec);
    const bg = plan.placements.find((p) => p.role === 'background');
    assert.deepEqual(
      [Math.round(bg.to.left), Math.round(bg.to.top), Math.round(bg.to.right), Math.round(bg.to.bottom)],
      [0, 0, fmt.width, fmt.height], fmt.id,
    );
    const safe = safeRect(fmt.width, fmt.height, spec, fmt);
    for (const p of plan.placements.filter((q) => ['headline', 'body', 'cta', 'logo'].includes(q.role))) {
      assert.ok(p.to.left >= safe.left - 0.5 && p.to.right <= safe.right + 0.5, `${fmt.id}/${p.name} x`);
      assert.ok(p.to.top >= safe.top - 0.5 && p.to.bottom <= safe.bottom + 0.5, `${fmt.id}/${p.name} y`);
    }
  }
});

test('variant: story format respects the platform UI zones', () => {
  const story = spec.formats.find((f) => f.id === 'story');
  const { plan } = previewVariant(sampleDoc(), story, spec);
  const logo = plan.placements.find((p) => p.name === 'Logo');
  assert.ok(logo.to.top >= 1920 * 0.14 - 0.5, 'logo sits below the story header zone');
});

test('variant: anchors are preserved (left stays left, bottom stays bottom)', () => {
  const doc = sampleDoc();
  const sq = spec.formats.find((f) => f.id === 'ig-square');
  const { plan } = previewVariant(doc, sq, spec);
  const cta = plan.placements.find((p) => p.name === 'CTA button');
  const head = plan.placements.find((p) => p.name === 'Headline');
  assert.ok(cta.to.left < sq.width / 2, 'CTA stays on the left');
  assert.ok(cta.to.top > head.to.bottom, 'CTA stays below the headline');
});

test('variant: extreme aspect ratios get an explicit warning', () => {
  const leaderboard = { id: 'lb', name: 'Leaderboard', width: 728, height: 90 };
  const { warnings, findings } = previewVariant(sampleDoc(), leaderboard, spec);
  assert.ok(warnings.some((x) => x.kind === 'extreme-scale'));
  assert.ok(findings.some((x) => x.rule === 'min-text'), 'tiny text is reported by the same audit');
});

test('variant: applyPlan scales text size and group children', () => {
  const doc = sampleDoc();
  const fmt = { id: 'half', name: 'half', width: 540, height: 675 };
  const out = applyPlan(doc, planVariant(doc, fmt, spec));
  assert.equal(out.width, 540);
  const head = out.layers.find((l) => l.name === 'Headline');
  assert.ok(head.text.sizePx < 120 && head.text.sizePx > 40);
  assert.equal(doc.width, 1080, 'input must not be mutated');
  assert.equal(rules(audit(out, spec, { hygiene: false })).includes('safe-zone'), false);
});

test('variant: a button and its label move as one cluster and stay attached', () => {
  const doc = sampleDoc();
  for (const fmt of spec.formats) {
    const { plan } = previewVariant(doc, fmt, spec);
    const btn = plan.placements.find((p) => p.name === 'CTA button');
    const label = plan.placements.find((p) => p.name === 'Shop now');
    const srcDx = label.from.left - btn.from.left;
    const srcDy = label.from.top - btn.from.top;
    assert.ok(Math.abs((label.to.left - btn.to.left) - srcDx * label.fontScale) < 1.5, `${fmt.id} dx`);
    assert.ok(Math.abs((label.to.top - btn.to.top) - srcDy * label.fontScale) < 1.5, `${fmt.id} dy`);
  }
});

test('variant: clamping into the story safe zone does not stack clusters on top of each other', () => {
  const story = spec.formats.find((f) => f.id === 'story');
  const { plan, warnings } = previewVariant(sampleDoc(), story, spec);
  const btn = plan.placements.find((p) => p.name === 'CTA button');
  const fine = plan.placements.find((p) => p.name === 'Fine print');
  assert.ok(btn.to.bottom <= fine.to.top + 0.5, 'button sits above the fine print');
  assert.equal(warnings.filter((x) => x.kind === 'overlap').length, 0);
});
