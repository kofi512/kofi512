'use strict';
// AI layout director. Sends Claude a picture of the design plus its layer data and the target
// formats; Claude answers with a placement for every layer in every format. Nothing it says is
// trusted blindly: planFromAi() validates the answer, keeps any layer the model forgot, forces
// backgrounds to cover the canvas and pulls content back inside the safe zone. If the call
// fails or the answer is unusable, the deterministic fit/anchor plans still apply.
//
// The plugin runs inside Photoshop (UXP) with no bundler, so this talks to the Messages API with
// plain fetch. Only an image of the document and its layer names/text leave the machine.

const { inferRoles, hasBounds, w, h } = require('./roles');
const { safeRect } = require('./spec');
const { _internal } = require('./variants');

const { placeBackground, makePlacement, finishPlan, visibleLayers, SAFE_ROLES } = _internal;

const API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-opus-5-5';
const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (best layouts)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (cheaper)' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (cheapest)' },
];

const SYSTEM = `You are a senior art director adapting an existing Photoshop design to new canvas sizes.
You are given a picture of the source design, its top-level layers with pixel bounds, and target formats.
For EVERY target format return where each layer goes.

Rules:
- It must be recognisably the SAME design: same hierarchy, same reading order, same relationships (a button stays attached to its label, the logo stays a logo, text stays readable).
- Never crop or drop content. Every layer except the background must lie fully inside the canvas.
- Keep text and logos inside the format's safe rectangle (given in pixels). Text must not become smaller than the format's minTextPx; make it larger when there is room.
- Use the new canvas well. For a portrait design going to a landscape or wide canvas, re-flow instead of shrinking: e.g. headline and copy in a left column, product image on the right. For landscape to portrait, stack. Do not leave the content as a small island in a big empty canvas.
- Uniform scale only: a layer keeps its aspect ratio (give "scale", a multiplier of its source size). Only plain shapes or fills that act as bars/panels may be stretched: give "width" and "height" for those, otherwise null.
- Background layers are filled automatically; place them anyway (left 0, top 0, scale 1).
- All numbers are pixels in the TARGET canvas; "left"/"top" is the layer's new top-left corner.
- "rationale" is one short sentence describing the layout idea for that format.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['formats'],
  properties: {
    formats: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'rationale', 'layers'],
        properties: {
          id: { type: 'string' },
          rationale: { type: 'string' },
          layers: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'left', 'top', 'scale', 'width', 'height'],
              properties: {
                id: { type: 'string' },
                left: { type: 'number' },
                top: { type: 'number' },
                scale: { type: 'number' },
                width: { anyOf: [{ type: 'number' }, { type: 'null' }] },
                height: { anyOf: [{ type: 'number' }, { type: 'null' }] },
              },
            },
          },
        },
      },
    },
  },
};

const r1 = (n) => Math.round(n);

/** Plain-data description of the document + targets that goes into the prompt. */
function describe(doc, formats, spec) {
  const roles = inferRoles(doc);
  return {
    source: { width: doc.width, height: doc.height },
    layers: visibleLayers(doc).map((l) => {
      const o = {
        id: l.id, name: l.name, kind: l.kind, role: roles[l.id],
        left: r1(l.bounds.left), top: r1(l.bounds.top), width: r1(w(l.bounds)), height: r1(h(l.bounds)),
      };
      if (l.text) o.text = { content: String(l.text.content || '').slice(0, 120), sizePx: r1(l.text.sizePx || 0), font: l.text.font };
      return o;
    }),
    formats: formats.map((f) => {
      const s = safeRect(f.width, f.height, spec, f);
      return {
        id: f.id, name: f.name, width: f.width, height: f.height,
        safe: { left: r1(s.left), top: r1(s.top), right: r1(s.right), bottom: r1(s.bottom) },
        minTextPx: r1((spec.minTextPct / 100) * Math.min(f.width, f.height)),
      };
    }),
    brand: { name: spec.name, fonts: spec.fonts },
  };
}

function buildRequest({ doc, formats, spec, model, previewB64, structured }) {
  const content = [];
  if (previewB64) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: previewB64 } });
  content.push({
    type: 'text',
    text: `${previewB64 ? 'The image above is the source design. ' : ''}Layout data (JSON):\n${JSON.stringify(describe(doc, formats, spec))}\n\nReturn a JSON object of the form {"formats":[{"id","rationale","layers":[{"id","left","top","scale","width","height"}]}]} covering every format id and every layer id.`,
  });
  const body = {
    model: model || DEFAULT_MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    messages: [{ role: 'user', content }],
    output_config: structured ? { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } } : { effort: 'medium' },
  };
  // Server-side refusal fallback (see Anthropic docs); dropped on the plain retry.
  if (structured) body.fallbacks = 'default';
  return body;
}

function headers(apiKey, structured) {
  const h = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    // Required by the API when it is called from a browser-like runtime such as UXP.
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  if (structured) h['anthropic-beta'] = 'server-side-fallback-2026-07-01';
  return h;
}

class AiError extends Error {}

function httpMessage(status, text) {
  let detail = '';
  try { detail = JSON.parse(text).error.message; } catch (e) { detail = String(text || '').slice(0, 200); }
  if (status === 401) return 'The API key was rejected (401). Check it on the Brand tab.';
  if (status === 403) return `The API key is not allowed to use this model (403). ${detail}`;
  if (status === 404) return `Model not found (404). Pick another model on the Brand tab. ${detail}`;
  if (status === 429) return 'Rate limited (429) — wait a moment and try again.';
  if (status >= 500) return `Anthropic is having problems (${status}) — try again shortly.`;
  return `The AI request failed (${status}). ${detail}`;
}

function textOf(data) {
  if (!data || data.stop_reason === 'refusal') throw new AiError('The model declined this request.');
  const t = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  if (!t.trim()) throw new AiError('The model returned no text.');
  return t;
}

/** Parse the first JSON object in a reply, tolerating code fences or stray prose. */
function parseJson(text) {
  try { return JSON.parse(text); } catch (e) { /* fall through */ }
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(text.slice(a, b + 1)); } catch (e) { /* fall through */ }
  }
  throw new AiError('The model did not return valid JSON.');
}

/**
 * Ask Claude for layouts. Returns { byFormat: { [formatId]: { rationale, layers } }, usage }.
 * `fetchImpl` is injectable for tests.
 */
async function requestLayouts({ apiKey, model, doc, formats, spec, previewB64, fetchImpl }) {
  if (!apiKey) throw new AiError('Add your Anthropic API key on the Brand tab first.');
  const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) throw new AiError('This environment cannot make network requests.');

  async function call(structured) {
    const res = await doFetch(API_URL, {
      method: 'POST',
      headers: headers(apiKey, structured),
      body: JSON.stringify(buildRequest({ doc, formats, spec, model, previewB64, structured })),
    });
    const text = await res.text();
    return { res, text };
  }

  let { res, text } = await call(true);
  // Schema/fallback features are optional niceties: retry plainly if the API objects to them.
  if (res.status === 400) ({ res, text } = await call(false));
  if (!res.ok) throw new AiError(httpMessage(res.status, text));

  let data;
  try { data = JSON.parse(text); } catch (e) { throw new AiError('Unreadable response from the API.'); }
  const parsed = parseJson(textOf(data));
  const byFormat = {};
  for (const f of Array.isArray(parsed.formats) ? parsed.formats : []) {
    if (f && typeof f.id === 'string' && Array.isArray(f.layers)) byFormat[f.id] = { rationale: String(f.rationale || ''), layers: f.layers };
  }
  if (!Object.keys(byFormat).length) throw new AiError('The model returned no layouts.');
  return { byFormat, usage: data.usage || null };
}

/**
 * Turn one format's AI answer into a plan. Anything missing, non-numeric or absurd falls back
 * to the "same design, scaled" transform for that layer, so no layer is ever lost.
 */
function planFromAi(doc, format, spec, aiFormat) {
  const roles = inferRoles(doc);
  const tw = format.width;
  const th = format.height;
  const fitScale = Math.min(tw / doc.width, th / doc.height);
  const fx = (tw - doc.width * fitScale) / 2;
  const fy = (th - doc.height * fitScale) / 2;
  const byId = new Map((aiFormat.layers || []).map((l) => [String(l.id), l]));
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  let repaired = 0;

  const placements = visibleLayers(doc).map((l) => {
    const role = roles[l.id];
    if (role === 'background') {
      const bg = placeBackground(l, tw, th);
      return makePlacement(l, role, bg.to, bg.sx, bg.sy, { free: true });
    }
    const b = l.bounds;
    const lw = w(b);
    const lh = h(b);
    const a = byId.get(String(l.id));
    const left = a ? num(a.left) : null;
    const top = a ? num(a.top) : null;
    let scale = a ? num(a.scale) : null;
    const stretch = !!a && num(a.width) !== null && num(a.height) !== null && (l.kind === 'shape' || l.kind === 'solid');

    if (left === null || top === null || (scale === null && !stretch)) {
      repaired++;
      const to = { left: fx + b.left * fitScale, top: fy + b.top * fitScale, right: fx + b.right * fitScale, bottom: fy + b.bottom * fitScale };
      return makePlacement(l, role, to, fitScale, fitScale, { clampable: SAFE_ROLES.has(role), free: role === 'image' });
    }
    if (stretch) {
      const nw = Math.min(Math.max(a.width, 1), tw * 4);
      const nh = Math.min(Math.max(a.height, 1), th * 4);
      return makePlacement(l, role, { left, top, right: left + nw, bottom: top + nh }, nw / lw, nh / lh, { free: true });
    }
    scale = Math.min(Math.max(scale, 0.02), 20);
    const to = { left, top, right: left + lw * scale, bottom: top + lh * scale };
    return makePlacement(l, role, to, scale, scale, { clampable: SAFE_ROLES.has(role), free: role === 'image' });
  });

  // Typical content scale (median) — used for the "shrinks too much" warning and stacking gaps.
  const scales = placements.filter((p) => p.role !== 'background').map((p) => Math.min(p.scaleX, p.scaleY)).sort((x, y) => x - y);
  const typical = scales.length ? scales[Math.floor(scales.length / 2)] : fitScale;
  const plan = finishPlan(doc, format, spec, placements, 'ai', aiFormat.rationale || 'AI layout', typical);
  plan.repaired = repaired;
  return plan;
}

module.exports = {
  DEFAULT_MODEL, MODELS, SCHEMA, AiError, describe, buildRequest, requestLayouts, planFromAi, parseJson,
};
