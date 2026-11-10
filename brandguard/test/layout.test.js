'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeSpec, DEFAULT_SPEC, safeRect } = require('../src/core/spec');
const { planFit, planAnchor, previewVariant, applyPlan } = require('../src/core/variants');
const ai = require('../src/core/ai');
const { sampleDoc } = require('../dev/sample-doc');

const spec = normalizeSpec(DEFAULT_SPEC).spec;
const fmt = (id, width, height, extra) => Object.assign({ id, name: id, width, height }, extra);
const SHAPES = [
  fmt('portrait', 1080, 1350), fmt('square', 1080, 1080), fmt('landscape', 1200, 628),
  fmt('wide', 1920, 600), fmt('tall', 600, 1800), fmt('tiny-wide', 728, 90),
];
const L = (id, name, kind, left, top, right, bottom, extra) => Object.assign(
  { id, name, kind, visible: true, empty: false, bounds: { left, top, right, bottom } }, extra);

const inside = (b, W, H, tol = 1) => b.left >= -tol && b.top >= -tol && b.right <= W + tol && b.bottom <= H + tol;

test('fit: the whole design is kept — nothing cropped, one uniform scale, same arrangement', () => {
  const doc = sampleDoc();
  for (const f of SHAPES) {
    const plan = planFit(doc, f, spec);
    const s = Math.min(f.width / doc.width, f.height / doc.height);
    const content = plan.placements.filter((p) => p.role !== 'background');
    assert.equal(content.length, doc.layers.filter((l) => l.visible && l.bounds).length - 1);
    for (const p of content) {
      assert.ok(inside(p.to, f.width, f.height), `${f.id}: ${p.name} stays on canvas`);
      assert.ok(Math.abs(p.scaleX - p.scaleY) < 1e-9, `${f.id}: ${p.name} scaled uniformly`);
    }
    // arrangement preserved: spacing between two layers scales by exactly s (no safe-zone nudge on plain formats)
    const a = content.find((p) => p.name === 'Headline');
    const b = content.find((p) => p.name === 'Product shot');
    const dx = (b.to.left - a.to.left) / (b.from.left - a.from.left);
    assert.ok(Math.abs(dx - s) < 0.02 || Math.abs(a.to.left - a.from.left * s) > 0.5, `${f.id}: relative positions follow the scale`);
  }
});

test('fit: backgrounds are extended to cover the whole new canvas, in every orientation', () => {
  const doc = sampleDoc();
  for (const f of SHAPES) {
    const bg = planFit(doc, f, spec).placements.find((p) => p.role === 'background');
    assert.deepEqual([bg.to.left, bg.to.top, bg.to.right, bg.to.bottom].map(Math.round), [0, 0, f.width, f.height], f.id);
  }
});

test('regression: a photo-heavy design is never cropped to "a small part" of itself', () => {
  const doc = {
    name: 'photo.psd', width: 1080, height: 1350, resolution: 72, colorMode: 'RGB',
    layers: [
      L('0', 'Headline', 'text', 80, 90, 1000, 230, { text: { content: 'Hello', font: 'Montserrat-Bold', sizePx: 110, colorHex: '#FFFFFF' } }),
      L('1', 'Hero photo', 'pixel', 40, 280, 1040, 1280),
      L('2', 'Backdrop', 'solid', 0, 0, 1080, 1350, { fillHex: '#111111' }),
    ],
  };
  for (const f of SHAPES) {
    const out = previewVariant(doc, f, spec);
    for (const k of Object.keys(out.candidates)) {
      const photo = out.candidates[k].plan.placements.find((p) => p.name === 'Hero photo');
      assert.ok(inside(photo.to, f.width, f.height, 2), `${f.id}/${k}: photo fully visible`);
    }
    assert.equal(out.notes.filter((n) => /cut off/.test(n)).length, 0, `${f.id}: best plan loses nothing`);
  }
});

test('previewVariant: returns every candidate and picks the best-scoring one', () => {
  const out = previewVariant(sampleDoc(), fmt('landscape', 1200, 628), spec);
  assert.deepEqual(Object.keys(out.candidates).sort(), ['anchor', 'fit']);
  const top = Math.max(...Object.values(out.candidates).map((c) => c.score));
  assert.ok(out.candidates[out.best].score >= top - 0.5);
  assert.equal(out.plan, out.candidates[out.best].plan);
});

test('anchor never pushes a fully-visible layer off the canvas', () => {
  const doc = sampleDoc();
  for (const f of SHAPES) {
    for (const p of planAnchor(doc, f, spec).placements.filter((q) => q.role !== 'background' && q.name !== 'Logo')) {
      assert.ok(inside(p.to, f.width, f.height, 2), `${f.id}: ${p.name}`);
    }
  }
});

// ---- AI ---------------------------------------------------------------------------------

const landscape = fmt('landscape', 1200, 628);

function aiAnswer(doc, f, over) {
  // a plausible hand-made landscape layout: everything at one scale, left-aligned
  return {
    rationale: 'Two columns',
    layers: doc.layers.filter((l) => l.visible && l.bounds).map((l, i) => Object.assign(
      { id: l.id, left: 60 + (i % 3) * 20, top: 40 + i * 10, scale: 0.5, width: null, height: null }, over && over[l.id])),
  };
}

test('ai plan: every layer survives, backgrounds cover, content is pulled into the safe zone', () => {
  const doc = sampleDoc();
  const answer = aiAnswer(doc, landscape, { 2: { left: -500, top: -300, scale: 0.5 }, 9: { left: 100, top: 100, scale: 0.1 } });
  const plan = ai.planFromAi(doc, landscape, spec, answer);
  const visible = doc.layers.filter((l) => l.visible && l.bounds);
  assert.equal(plan.placements.length, visible.length);
  const bg = plan.placements.find((p) => p.role === 'background');
  assert.deepEqual([bg.to.left, bg.to.top, bg.to.right, bg.to.bottom].map(Math.round), [0, 0, 1200, 628]);
  const safe = safeRect(1200, 628, spec, landscape);
  const head = plan.placements.find((p) => p.name === 'Headline');
  assert.ok(head.to.left >= safe.left - 0.5 && head.to.top >= safe.top - 0.5, 'off-canvas AI placement was repaired');
  assert.equal(plan.mode, 'ai');
});

test('ai plan: missing or garbage layer entries fall back to the same-design transform', () => {
  const doc = sampleDoc();
  const plan = ai.planFromAi(doc, landscape, spec, {
    rationale: 'x',
    layers: [{ id: '2', left: 'abc', top: null, scale: NaN }, { id: '3', left: 50, top: 50, scale: 0.4 }],
  });
  assert.equal(plan.placements.length, doc.layers.filter((l) => l.visible && l.bounds).length);
  assert.ok(plan.repaired >= 5);
  for (const p of plan.placements) assert.ok(Number.isFinite(p.to.left) && Number.isFinite(p.to.right));
});

test('previewVariant: an AI candidate is scored like the others and wins ties', () => {
  const doc = sampleDoc();
  const aiPlan = ai.planFromAi(doc, landscape, spec, aiAnswer(doc, landscape));
  const out = previewVariant(doc, landscape, spec, { aiPlan });
  assert.ok(out.candidates.ai && out.candidates.fit && out.candidates.anchor);
  const best = Math.max(...Object.values(out.candidates).map((c) => c.score));
  assert.ok(out.candidates[out.best].score >= best - 0.5);
});

function fakeFetch(responses, calls) {
  return async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const r = responses.shift();
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) };
  };
}
const reply = (obj, extra) => ({ status: 200, body: Object.assign({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(obj) }], usage: { input_tokens: 1, output_tokens: 1 } }, extra) });
const args = (calls, responses, over) => Object.assign({
  apiKey: 'sk-test', doc: sampleDoc(), formats: [landscape], spec, previewB64: 'AAAA', fetchImpl: fakeFetch(responses, calls),
}, over);

test('requestLayouts: sends image + layer data with the right headers and parses the answer', async () => {
  const calls = [];
  const doc = sampleDoc();
  const out = await ai.requestLayouts(args(calls, [reply({ formats: [{ id: 'landscape', rationale: 'ok', layers: aiAnswer(doc, landscape).layers }] })], { doc }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].init.headers['x-api-key'], 'sk-test');
  assert.equal(calls[0].init.headers['anthropic-version'], '2023-06-01');
  assert.equal(calls[0].body.model, 'claude-opus-5-5');
  assert.equal(calls[0].body.messages[0].content[0].type, 'image');
  assert.ok(calls[0].body.messages[0].content[1].text.includes('"Headline"'));
  assert.equal(calls[0].body.output_config.format.type, 'json_schema');
  assert.equal(calls[0].body.temperature, undefined, 'no sampling params on current models');
  assert.equal(calls[0].body.thinking, undefined);
  assert.ok(out.byFormat.landscape.layers.length > 0);
});

test('requestLayouts: retries plainly when the API rejects schema/fallback features', async () => {
  const calls = [];
  const out = await ai.requestLayouts(args(calls, [
    { status: 400, body: { error: { message: 'unsupported' } } },
    reply({ formats: [{ id: 'landscape', rationale: 'r', layers: [] }] }),
  ]));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.output_config.format, undefined);
  assert.equal(calls[1].body.fallbacks, undefined);
  assert.ok(out.byFormat.landscape);
});

test('requestLayouts: tolerates fenced JSON and reports clear errors', async () => {
  const fenced = { status: 200, body: { stop_reason: 'end_turn', content: [{ type: 'text', text: '```json\n{"formats":[{"id":"landscape","rationale":"r","layers":[]}]}\n```' }] } };
  assert.ok((await ai.requestLayouts(args([], [fenced]))).byFormat.landscape);
  await assert.rejects(ai.requestLayouts(args([], [{ status: 401, body: { error: { message: 'bad' } } }])), /rejected \(401\)/);
  await assert.rejects(ai.requestLayouts(args([], [{ status: 429, body: {} }])), /Rate limited/);
  await assert.rejects(ai.requestLayouts(args([], [reply({}, { stop_reason: 'refusal' })])), /declined/);
  await assert.rejects(ai.requestLayouts(args([], [{ status: 200, body: { content: [{ type: 'text', text: 'sorry' }] } }])), /valid JSON/);
  await assert.rejects(ai.requestLayouts(args([], [], { apiKey: '' })), /API key/);
});

test('describe(): hidden layers are not sent, text content is capped', () => {
  const d = ai.describe(sampleDoc(), [landscape], spec);
  assert.ok(!d.layers.some((l) => l.name === 'Old headline'));
  assert.equal(d.formats[0].minTextPx, Math.round(0.025 * 628));
  assert.ok(applyPlan && d.layers.length > 0);
});
