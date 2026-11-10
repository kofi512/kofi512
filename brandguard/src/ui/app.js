'use strict';
// BrandGuard panel UI. Framework-free and DOM-light so it runs inside Photoshop's UXP
// (no CSS grid, no external libs) and in a plain browser for the dev preview.
//
// start(adapter, root): `adapter` is the only thing that touches Photoshop — see src/ps/adapter.js
// for the contract and dev/mock-adapter.js for an in-memory implementation.

const { normalizeSpec, DEFAULT_SPEC, clone, safeRect } = require('../core/spec');
const { audit, summarize, selectSafeFixes } = require('../core/rules');
const { previewVariant } = require('../core/variants');
const { inferRoles } = require('../core/roles');
const ai = require('../core/ai');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const RATIOS = [[1, 1], [4, 5], [5, 4], [3, 4], [4, 3], [9, 16], [16, 9], [2, 3], [3, 2], [191, 100]];
function ratioLabel(w, h) {
  const r = w / h;
  for (const [a, b] of RATIOS) {
    if (Math.abs(r - a / b) / (a / b) < 0.01) return b === 100 ? '1.91:1' : `${a}:${b}`;
  }
  return `${r.toFixed(2)}:1`;
}

const SEV = { error: 'Error', warn: 'Warning', info: 'Note' };
const TABS = [['audit', 'Preflight'], ['variants', 'Variants'], ['brand', 'Brand']];

function start(adapter, root) {
  const state = {
    tab: 'audit',
    filter: 'all',
    spec: normalizeSpec(DEFAULT_SPEC).spec,
    specErrors: [],
    doc: null,
    findings: [],
    previews: {}, // formatId -> previewVariant()
    picked: new Set(),
    exportPng: false,
    settings: { apiKey: '', model: ai.DEFAULT_MODEL }, // AI settings; stored apart from the brand spec
    aiLayouts: {}, // formatId -> { rationale, layers } from Claude
    aiSig: '',
    override: {}, // formatId -> 'fit' | 'anchor' | 'ai'
    panelW: 340,
    busy: false,
    status: { kind: '', text: '' },
  };

  root.innerHTML = `
    <div id="hdr"></div>
    <div id="tabs"></div>
    <div id="view"></div>
    <div id="foot"></div>`;
  const $ = (id) => root.querySelector('#' + id);

  // ---------------------------------------------------------------- data flow
  function recompute() {
    state.findings = state.doc ? audit(state.doc, state.spec) : [];
    state.previews = {};
    if (state.doc) {
      // AI answers belong to one document; drop them if a different one is opened.
      const sig = `${state.doc.name}|${state.doc.width}x${state.doc.height}|${state.doc.layers.map((l) => l.id).join(',')}`;
      if (sig !== state.aiSig) { state.aiSig = sig; state.aiLayouts = {}; state.override = {}; }
      for (const f of state.spec.formats) {
        let aiPlan;
        if (state.aiLayouts[f.id]) {
          try { aiPlan = ai.planFromAi(state.doc, f, state.spec, state.aiLayouts[f.id]); } catch (e) { aiPlan = undefined; }
        }
        state.previews[f.id] = previewVariant(state.doc, f, state.spec, { aiPlan });
      }
    }
    // keep only formats that still exist
    state.picked = new Set([...state.picked].filter((id) => state.previews[id]));
  }

  async function scan(message) {
    try {
      state.doc = await adapter.readDocument();
    } catch (e) {
      state.doc = null;
      setStatus('error', `Could not read the document: ${e.message || e}`);
    }
    recompute();
    if (message) setStatus('ok', message);
    renderAll();
  }

  function setStatus(kind, text) {
    state.status = { kind, text };
    renderFoot();
  }

  async function run(label, fn) {
    if (state.busy) return;
    state.busy = true;
    setStatus('busy', label);
    renderAll();
    try {
      await fn();
    } catch (e) {
      setStatus('error', String((e && e.message) || e));
    } finally {
      state.busy = false;
      renderAll();
    }
  }

  async function applyFixes(fixes, label) {
    if (!fixes.length) return;
    const result = await adapter.applyFixes(fixes, label);
    await scan();
    const failed = result.failed || [];
    if (failed.length) {
      setStatus('error', `${result.applied} fixed, ${failed.length} failed: ${failed[0].error}`);
    } else {
      setStatus('ok', `${result.applied} fix${result.applied === 1 ? '' : 'es'} applied — undo with one Ctrl/Cmd+Z.`);
    }
  }

  async function fixAll() {
    // Sizes/fonts/colours first, then re-audit before nudging so moves use final bounds.
    let total = 0;
    for (let round = 0; round < 3; round++) {
      const fixes = selectSafeFixes(state.findings);
      const nonMove = fixes.filter((f) => f.type !== 'moveBy');
      const batch = nonMove.length ? nonMove : fixes;
      if (!batch.length) break;
      const result = await adapter.applyFixes(batch, 'BrandGuard: fix all');
      total += result.applied;
      await scan();
      if ((result.failed || []).length) {
        setStatus('error', `${total} fixed, ${result.failed.length} failed: ${result.failed[0].error}`);
        return;
      }
    }
    setStatus('ok', total ? `Fixed ${total} issue${total === 1 ? '' : 's'}.` : 'Nothing to fix automatically.');
  }

  /** The candidate layout currently selected for a format (user override, else best score). */
  function chosen(f) {
    const p = state.previews[f.id];
    const k = state.override[f.id];
    const key = k && p.candidates[k] ? k : p.best;
    return { key, ...p.candidates[key], candidates: p.candidates, best: p.best };
  }

  async function askAi() {
    if (!state.settings.apiKey) {
      state.tab = 'brand';
      setStatus('error', 'Add your Anthropic API key under “AI layout” first.');
      renderAll();
      return;
    }
    const formats = state.picked.size ? state.spec.formats.filter((f) => state.picked.has(f.id)) : state.spec.formats;
    setStatus('busy', 'Rendering a preview of your design…');
    let previewB64 = null;
    try { previewB64 = await adapter.renderPreview(1024); } catch (e) { /* layer data alone still works */ }
    setStatus('busy', `Asking Claude to lay out ${formats.length} format${formats.length === 1 ? '' : 's'}…`);
    const out = await ai.requestLayouts({
      apiKey: state.settings.apiKey, model: state.settings.model, doc: state.doc, formats,
      spec: state.spec, previewB64, fetchImpl: adapter.fetch,
    });
    Object.assign(state.aiLayouts, out.byFormat);
    for (const id of Object.keys(out.byFormat)) delete state.override[id];
    recompute();
    const got = formats.filter((f) => out.byFormat[f.id]);
    const wins = got.filter((f) => state.previews[f.id].best === 'ai').length;
    setStatus('ok', `AI laid out ${got.length} format${got.length === 1 ? '' : 's'}; it scored best on ${wins}. Switch any card between Same design / Anchored / AI.`);
  }

  async function generate() {
    const formats = state.spec.formats.filter((f) => state.picked.has(f.id));
    if (!formats.length) return;
    let folder = null;
    if (state.exportPng) {
      folder = await adapter.pickFolder();
      if (!folder) { setStatus('', 'Export cancelled — choose a folder or untick “Export PNG”.'); return; }
    }
    let made = 0;
    const problems = [];
    for (const f of formats) {
      setStatus('busy', `Creating ${f.name} (${made + 1}/${formats.length})…`);
      try {
        await adapter.createVariant(chosen(f).plan, { exportFolder: folder });
        made++;
      } catch (e) {
        problems.push(`${f.name}: ${(e && e.message) || e}`);
      }
    }
    await adapter.reactivateSource();
    await scan();
    if (problems.length) setStatus('error', `${made} created, ${problems.length} failed — ${problems[0]}`);
    else setStatus('ok', `Created ${made} variant${made === 1 ? '' : 's'}${folder ? ' and exported PNGs' : ''}.`);
  }

  // ---------------------------------------------------------------- rendering
  function renderAll() {
    renderHdr(); renderTabs(); renderView(); renderFoot();
    layout();
  }

  /**
   * Size the scroll area to whatever the panel currently is. Done in JS (not only CSS) because
   * percentage heights are unreliable in UXP panels, which is what stopped the panel from
   * filling/extending when it was resized or docked.
   */
  function layout() {
    const H = window.innerHeight || document.documentElement.clientHeight || 0;
    const W = window.innerWidth || document.documentElement.clientWidth || 0;
    if (!H) return;
    root.style.height = `${H}px`;
    const used = $('hdr').offsetHeight + $('tabs').offsetHeight + $('foot').offsetHeight;
    const vh = `${Math.max(80, H - used)}px`;
    if ($('view').style.height !== vh) $('view').style.height = vh;
    if (W && Math.abs(W - state.panelW) > 8) {
      state.panelW = W;
      if (state.tab === 'variants' && state.doc && !state.busy) renderView();
    }
  }

  function renderHdr() {
    const d = state.doc;
    $('hdr').innerHTML = `
      <div class="hdr-top">
        <span class="mark"></span><span class="title">BrandGuard</span>
        <span class="chip" title="Active brand spec">${esc(state.spec.name)}</span>
        <span class="spacer"></span>
        <button class="icon-btn" data-action="rescan" title="Rescan document"${state.busy ? ' disabled' : ''}>Rescan</button>
      </div>
      <div class="docline">${d
        ? `<b>${esc(d.name)}</b> · ${d.width}×${d.height} px · ${esc(d.colorMode || '?')} · ${d.resolution || '?'} ppi`
        : 'No document open'}</div>`;
  }

  function renderTabs() {
    const s = summarize(state.findings);
    const counts = { audit: s.error + s.warn, variants: state.picked.size, brand: 0 };
    $('tabs').innerHTML = TABS.map(([id, label]) => {
      const n = counts[id];
      const badge = n ? `<span class="badge ${id === 'audit' && s.error ? 'b-error' : ''}">${n}</span>` : '';
      return `<button class="tab${state.tab === id ? ' on' : ''}" data-tab="${id}">${label}${badge}</button>`;
    }).join('');
  }

  function renderView() {
    const el = $('view');
    const scroll = el.scrollTop;
    if (state.tab === 'brand') el.innerHTML = brandView();
    else if (!state.doc) el.innerHTML = emptyView();
    else el.innerHTML = state.tab === 'audit' ? auditView() : variantsView();
    el.scrollTop = scroll;
  }

  function emptyView() {
    return `<div class="empty"><div class="empty-art"></div><p><b>Open a document</b></p>
      <p class="muted">BrandGuard checks it against your brand spec and builds size variants.</p></div>`;
  }

  // ---- Preflight
  function auditView() {
    const s = summarize(state.findings);
    const safeCount = selectSafeFixes(state.findings).length;
    const all = state.findings;
    const shown = state.filter === 'all' ? all : all.filter((f) => f.severity === state.filter);
    const stat = (k, label) => `<button class="stat st-${k}${state.filter === k ? ' on' : ''}" data-filter="${k}">
        <span class="stat-n">${s[k]}</span><span class="stat-l">${label}</span></button>`;

    const header = all.length
      ? `<div class="stats">${stat('error', 'Errors')}${stat('warn', 'Warnings')}${stat('info', 'Notes')}</div>
         <div class="bar">
           <button class="btn primary" data-action="fixall"${safeCount && !state.busy ? '' : ' disabled'}>Fix ${safeCount} safe issue${safeCount === 1 ? '' : 's'}</button>
           ${state.filter !== 'all' ? '<button class="btn quiet" data-filter="all">Show all</button>' : ''}
         </div>
         <p class="hint">“Safe” fixes never delete anything. Deleting layers is always a manual click.</p>`
      : `<div class="clear"><span class="tick">✓</span><div><b>All clear</b><div class="muted">Everything on this document matches “${esc(state.spec.name)}”.</div></div></div>`;

    const items = shown.map((f, i) => {
      const idx = state.findings.indexOf(f);
      const fix = f.fix
        ? `<button class="btn ${f.fix.safe === false ? 'danger' : 'ghost'}" data-action="fix" data-i="${idx}"${state.busy ? ' disabled' : ''}>${esc(f.fix.label)}</button>`
        : '';
      const sel = f.layerId !== null && f.layerId !== undefined
        ? `<button class="btn quiet" data-action="select" data-i="${idx}">Select layer</button>` : '';
      return `<div class="item sev-${f.severity}">
        <div class="item-head"><span class="sev">${SEV[f.severity]}</span><b>${esc(f.title)}</b>
          ${f.layerName ? `<span class="layer" title="${esc(f.layerName)}">${esc(f.layerName)}</span>` : ''}</div>
        <div class="item-msg">${esc(f.message)}</div>
        ${fix || sel ? `<div class="item-act">${fix}${sel}</div>` : ''}
      </div>`;
    }).join('');
    return header + `<div class="list">${items}</div>`;
  }

  // ---- Variants
  function wire(doc, plan, fmt, size) {
    // Draws layer boxes (from the doc, or from a plan) inside a `size`-px box.
    const W = plan ? fmt.width : doc.width;
    const H = plan ? fmt.height : doc.height;
    const k = Math.min(size / W, size / H);
    const roles = inferRoles(doc);
    const boxes = plan
      ? plan.placements.map((p) => ({ role: p.role, b: p.to }))
      : doc.layers.filter((l) => l.visible && l.bounds).map((l) => ({ role: roles[l.id], b: l.bounds }));
    const sr = safeRect(W, H, state.spec, plan ? fmt : null);
    const pos = (b) => `left:${(b.left * k).toFixed(1)}px;top:${(b.top * k).toFixed(1)}px;width:${Math.max(1, (b.right - b.left) * k).toFixed(1)}px;height:${Math.max(1, (b.bottom - b.top) * k).toFixed(1)}px`;
    const order = { background: 0, image: 1, graphic: 2, group: 2 };
    boxes.sort((a, b) => (order[a.role] ?? 3) - (order[b.role] ?? 3));
    return `<div class="wire" style="width:${(W * k).toFixed(1)}px;height:${(H * k).toFixed(1)}px">
      ${boxes.map((x) => `<i class="r-${x.role}" style="${pos(x.b)}"></i>`).join('')}
      <i class="safe" style="${pos(sr)}"></i></div>`;
  }

  const STRAT = { fit: 'Same design', anchor: 'Anchored', ai: 'AI' };

  function variantsView() {
    const d = state.doc;
    const fmts = state.spec.formats;
    const ts = Math.max(64, Math.min(200, Math.round(state.panelW * 0.3)));
    const cards = fmts.map((f) => {
      const c = chosen(f);
      const on = state.picked.has(f.id);
      const issues = c.findings.length + c.warnings.length + c.notes.length;
      const msgs = [...c.notes, ...c.warnings.map((x) => x.message), ...c.findings.map((x) => `${x.layerName}: ${x.message}`)].slice(0, 2);
      const chips = ['fit', 'anchor', 'ai'].filter((k) => c.candidates[k]).map((k) =>
        `<button class="strat${c.key === k ? ' on' : ''}" data-action="strat" data-id="${esc(f.id)}" data-k="${k}" title="${esc(c.candidates[k].label)} — score ${c.candidates[k].score}">${STRAT[k]}${c.best === k ? ' ★' : ''}</button>`).join('');
      return `<div class="card${on ? ' on' : ''}" data-action="toggle" data-id="${esc(f.id)}">
        <div class="check">${on ? '✓' : ''}</div>
        <div class="thumb" style="width:${ts + 8}px;height:${ts + 8}px">${wire(c.result, c.plan, f, ts)}</div>
        <div class="card-body">
          <div class="card-title">${esc(f.name)}</div>
          <div class="muted small">${f.width}×${f.height} · ${ratioLabel(f.width, f.height)}</div>
          <div class="strats">${chips}</div>
          <div class="card-status ${issues ? 'warn' : 'ok'}">${issues ? `${issues} to review` : '✓ Whole design kept, layout safe'}</div>
          ${c.key === 'ai' && state.aiLayouts[f.id] && state.aiLayouts[f.id].rationale ? `<div class="card-msg ai">✨ ${esc(state.aiLayouts[f.id].rationale)}</div>` : ''}
          ${msgs.map((m) => `<div class="card-msg">${esc(m)}</div>`).join('')}
        </div></div>`;
    }).join('');

    const n = state.picked.size || fmts.length;
    const hasKey = !!state.settings.apiKey;
    const aiBox = `<div class="ai-box">
        <div class="ai-title"><b>✨ AI layout</b><span class="muted small">${esc(state.settings.model)}</span></div>
        <p class="hint">Every format already gets the best of <b>Same design</b> (whole design scaled, never cropped) and <b>Anchored</b>. AI looks at your design and re-flows it — e.g. portrait → two columns for landscape — keeping all content.</p>
        ${hasKey
          ? `<button class="btn primary" data-action="askai"${state.busy ? ' disabled' : ''}>Improve ${n} format${n === 1 ? '' : 's'} with AI</button>`
          : '<button class="btn ghost" data-tab="brand">Add API key to enable AI</button>'}
      </div>`;

    return `
      <div class="source">
        <div class="thumb" style="width:${ts + 8}px;height:${ts + 8}px">${wire(d, null, null, ts)}</div>
        <div><div class="muted small">SOURCE</div><b>${esc(d.name)}</b>
          <div class="muted small">${d.width}×${d.height} · ${ratioLabel(d.width, d.height)}</div></div>
      </div>
      ${aiBox}
      <div class="bar">
        <button class="btn quiet" data-action="pickall">Select all</button>
        <button class="btn quiet" data-action="pickrec">Only clean</button>
        <button class="btn quiet" data-action="picknone">None</button>
      </div>
      <div class="cards">${cards || '<p class="muted">No formats in the brand spec — add some on the Brand tab.</p>'}</div>
      <label class="check-row"><input type="checkbox" data-field="exportPng"${state.exportPng ? ' checked' : ''}> Export PNG files too</label>`;
  }

  // ---- Brand
  function brandView() {
    const s = state.spec;
    const palette = s.palette.map((p, i) => `
      <div class="row">
        <span class="sw" style="background:${p.hex}"></span>
        <input class="in grow" data-field="pal-name" data-i="${i}" value="${esc(p.name)}">
        <input class="in hex" data-field="pal-hex" data-i="${i}" value="${p.hex}" maxlength="7">
        <button class="x" data-action="pal-del" data-i="${i}" title="Remove">×</button>
      </div>`).join('');
    const formats = s.formats.map((f, i) => `
      <div class="row">
        <input class="in grow" data-field="fmt-name" data-i="${i}" value="${esc(f.name)}">
        <input class="in num" data-field="fmt-w" data-i="${i}" value="${f.width}">
        <span class="muted">×</span>
        <input class="in num" data-field="fmt-h" data-i="${i}" value="${f.height}">
        <button class="x" data-action="fmt-del" data-i="${i}" title="Remove">×</button>
      </div>`).join('');
    const num = (field, label, val, hint) => `
      <div class="row"><label class="grow">${label}<div class="muted small">${hint}</div></label>
        <input class="in num" data-field="${field}" value="${val}"></div>`;
    return `
      <section><h3>Brand</h3>
        <div class="row"><input class="in grow" data-field="name" value="${esc(s.name)}"></div></section>
      <section><h3>Palette <span class="muted small">on-brand colours</span></h3>${palette}
        <button class="btn quiet" data-action="pal-add">+ Add colour</button></section>
      <section><h3>Fonts <span class="muted small">one per line · family or PostScript prefix</span></h3>
        <textarea class="in area" data-field="fonts" rows="3">${esc(s.fonts.join('\n'))}</textarea></section>
      <section><h3>Rules</h3>
        ${num('safeMarginPct', 'Safe margin %', s.safeMarginPct, 'of the shorter side')}
        ${num('minTextPct', 'Minimum text %', s.minTextPct, 'of the shorter side')}
        ${num('minContrast', 'Minimum contrast', s.minContrast, 'WCAG ratio (3 for large text)')}
        ${num('colorTolerance', 'Colour tolerance', s.colorTolerance, 'ΔE counted as on-palette')}
        ${num('minPpi', 'Minimum ppi', s.minPpi, '300 for print')}
        <div class="row"><label class="grow">Colour mode<div class="muted small">expected document mode</div></label>
          <select class="in" data-field="colorMode">${['RGB', 'CMYK', 'Grayscale', ''].map((m) =>
            `<option value="${m}"${s.colorMode === m ? ' selected' : ''}>${m || 'Any'}</option>`).join('')}</select></div></section>
      <section><h3>AI layout <span class="muted small">optional</span></h3>
        <div class="row"><input class="in grow" type="password" data-field="ai-key" placeholder="Anthropic API key (sk-ant-…)" value="${esc(state.settings.apiKey)}"></div>
        <div class="row"><select class="in grow" data-field="ai-model">${ai.MODELS.map((m) =>
          `<option value="${m.id}"${state.settings.model === m.id ? ' selected' : ''}>${esc(m.label)}</option>`).join('')}</select></div>
        <p class="hint">The key stays in this plugin's local storage and is only sent to api.anthropic.com. When you use AI, an image of the open document plus its layer names and text are sent. It is never saved in an exported brand spec.</p></section>
      <section><h3>Formats <span class="muted small">variant sizes in px</span></h3>${formats}
        <button class="btn quiet" data-action="fmt-add">+ Add format</button></section>
      ${state.specErrors.length ? `<div class="notice">${state.specErrors.map(esc).join('<br>')}</div>` : ''}`;
  }

  function renderFoot() {
    const st = state.status;
    let action = '';
    if (state.tab === 'variants' && state.doc) {
      const n = state.picked.size;
      action = `<button class="btn primary wide" data-action="generate"${n && !state.busy ? '' : ' disabled'}>${n ? `Create ${n} variant${n === 1 ? '' : 's'}` : 'Pick formats to create'}</button>`;
    } else if (state.tab === 'brand') {
      action = `<div class="bar tight">
        <button class="btn" data-action="import">Import spec…</button>
        <button class="btn" data-action="export">Export spec…</button>
        <button class="btn quiet" data-action="reset">Reset</button></div>`;
    }
    $('foot').innerHTML = `${st.text ? `<div class="status s-${st.kind}">${esc(st.text)}</div>` : ''}${action}`;
  }

  // ---------------------------------------------------------------- events
  async function persist() {
    try { await adapter.saveSpec(state.spec); } catch (e) { /* storage is best effort */ }
  }

  function setSpec(raw) {
    const res = normalizeSpec(raw);
    state.spec = res.spec;
    state.specErrors = res.errors;
    recompute();
    persist();
  }

  root.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-action],[data-tab],[data-filter]');
    if (!t || t.disabled) return;
    if (t.dataset.tab) { state.tab = t.dataset.tab; renderAll(); return; }
    if (t.dataset.filter) { state.filter = state.filter === t.dataset.filter && t.dataset.filter !== 'all' ? 'all' : t.dataset.filter; renderView(); renderHdr(); return; }
    const i = Number(t.dataset.i);
    const spec = clone(state.spec);
    switch (t.dataset.action) {
      case 'rescan': scan('Rescanned.'); break;
      case 'fixall': run('Fixing…', fixAll); break;
      case 'fix': run('Fixing…', () => applyFixes([state.findings[i].fix], 'BrandGuard: fix'));break;
      case 'select': adapter.selectLayer(state.findings[i].layerId).catch((e) => setStatus('error', String(e.message || e))); break;
      case 'toggle': {
        const id = t.dataset.id;
        if (state.picked.has(id)) state.picked.delete(id); else state.picked.add(id);
        renderTabs(); renderView(); renderFoot();
        break;
      }
      case 'pickall': state.picked = new Set(state.spec.formats.map((f) => f.id)); renderTabs(); renderView(); renderFoot(); break;
      case 'picknone': state.picked = new Set(); renderTabs(); renderView(); renderFoot(); break;
      case 'pickrec':
        state.picked = new Set(state.spec.formats.filter((f) => {
          const c = chosen(f);
          return !c.findings.length && !c.warnings.length && !c.notes.length;
        }).map((f) => f.id));
        renderTabs(); renderView(); renderFoot();
        break;
      case 'generate': run('Creating variants…', generate); break;
      case 'askai': run('Asking Claude…', askAi); break;
      case 'strat': state.override[t.dataset.id] = t.dataset.k; renderView(); break;
      case 'pal-add': spec.palette.push({ name: 'New colour', hex: '#808080' }); setSpec(spec); renderAll(); break;
      case 'pal-del': spec.palette.splice(i, 1); setSpec(spec); renderAll(); break;
      case 'fmt-add': spec.formats.push({ id: `custom-${spec.formats.length + 1}`, name: 'Custom', width: 1080, height: 1080 }); setSpec(spec); renderAll(); break;
      case 'fmt-del': spec.formats.splice(i, 1); setSpec(spec); renderAll(); break;
      case 'reset': setSpec(DEFAULT_SPEC); renderAll(); break;
      case 'export': adapter.exportSpecFile(state.spec).then((ok) => ok && setStatus('ok', 'Spec exported.')).catch((e) => setStatus('error', String(e.message || e))); break;
      case 'import':
        adapter.importSpecFile().then((raw) => {
          if (!raw) return;
          setSpec(raw);
          renderAll();
          setStatus(state.specErrors.length ? 'error' : 'ok', state.specErrors.length ? `Imported with ${state.specErrors.length} problem(s).` : 'Spec imported.');
        }).catch((e) => setStatus('error', `Import failed: ${e.message || e}`));
        break;
      default:
    }
  });

  root.addEventListener('change', (ev) => {
    const t = ev.target;
    const field = t.dataset && t.dataset.field;
    if (!field) return;
    if (field === 'exportPng') { state.exportPng = t.checked; return; }
    if (field === 'ai-key' || field === 'ai-model') {
      if (field === 'ai-key') state.settings.apiKey = t.value.trim();
      else state.settings.model = t.value;
      Promise.resolve(adapter.saveSettings(state.settings)).catch(() => {});
      return;
    }
    const i = Number(t.dataset.i);
    const spec = clone(state.spec);
    const v = t.value;
    if (field === 'name') spec.name = v;
    else if (field === 'fonts') spec.fonts = v.split('\n');
    else if (field === 'pal-name') spec.palette[i].name = v;
    else if (field === 'pal-hex') spec.palette[i].hex = v;
    else if (field === 'fmt-name') spec.formats[i].name = v;
    else if (field === 'fmt-w') spec.formats[i].width = v;
    else if (field === 'fmt-h') spec.formats[i].height = v;
    else spec[field] = field === 'colorMode' ? v : Number(v);
    setSpec(spec);
    // Re-render everything except the form being edited so focus is not stolen.
    renderHdr(); renderTabs(); renderFoot();
    if (state.specErrors.length || field.startsWith('pal') || field === 'fonts') renderView();
  });

  // ---------------------------------------------------------------- boot
  (async function init() {
    try {
      const saved = await adapter.loadSpec();
      if (saved) setSpec(saved);
    } catch (e) { /* first run */ }
    try {
      const st = await adapter.loadSettings();
      if (st) state.settings = Object.assign(state.settings, st);
    } catch (e) { /* first run */ }
    window.addEventListener('resize', layout);
    setInterval(layout, 400); // belt and braces: some hosts do not fire resize when docking
    await scan();
    if (adapter.onDocumentChange) adapter.onDocumentChange(() => { if (!state.busy) scan(); });
  })();

  return { state, scan };
}

module.exports = { start, ratioLabel };
