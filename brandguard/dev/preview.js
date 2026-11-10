'use strict';
// Browser preview of the panel with the mock adapter.
//   node dev/preview.js [outDir]   -> writes outDir/preview.html (+ screenshots if Playwright exists)
// Also acts as a UI smoke test: it clicks through the real panel and asserts on the result.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const outDir = path.resolve(process.argv[2] || path.join(__dirname, 'out'));
const files = [
  'src/core/color.js', 'src/core/spec.js', 'src/core/roles.js', 'src/core/rules.js',
  'src/core/variants.js', 'src/core/ai.js', 'src/ui/app.js', 'dev/sample-doc.js', 'dev/mock-adapter.js',
];

function bundle() {
  const defs = files.map((f) => `define(${JSON.stringify(f)}, function (module, exports, require) {\n${fs.readFileSync(path.join(root, f), 'utf8')}\n});`);
  return `
    const defs = {}, cache = {};
    function define(p, fn) { defs[p] = fn; }
    function resolve(from, name) {
      const parts = from.split('/').slice(0, -1).concat(name.split('/'));
      const out = [];
      for (const s of parts) { if (s === '..') out.pop(); else if (s !== '.') out.push(s); }
      let p = out.join('/'); if (!p.endsWith('.js')) p += '.js'; return p;
    }
    function load(p) {
      if (cache[p]) return cache[p].exports;
      const m = cache[p] = { exports: {} };
      defs[p](m, m.exports, (n) => load(resolve(p, n)));
      return m.exports;
    }
    ${defs.join('\n')}
  `;
}

function build() {
  fs.mkdirSync(outDir, { recursive: true });
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const mockClaude = fs.readFileSync(path.join(__dirname, 'mock-claude.js'), 'utf8');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}
    body{margin:0}</style></head><body><div id="app"></div>
    <script>${mockClaude}</script>
    <script>${bundle()}
    window.__mock = load('dev/mock-adapter.js').createMockAdapter(undefined, { fetch: window.__fakeFetch });
    window.__panel = load('src/ui/app.js').start(window.__mock, document.getElementById('app'));
    </script></body></html>`;
  const file = path.join(outDir, 'preview.html');
  fs.writeFileSync(file, html);
  return file;
}

async function main() {
  const file = build();
  console.log('preview written to', file);
  let chromium;
  try { ({ chromium } = require('playwright')); } catch (e) { return; }

  const assert = require('node:assert/strict');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 340, height: 760 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('file://' + file);
  await page.waitForSelector('.item');
  const shot = (name) => page.screenshot({ path: path.join(outDir, name), fullPage: false });
  const text = (sel) => page.$$eval(sel, (els) => els.map((e) => e.textContent.trim()));

  // 1. Preflight
  await shot('1-preflight.png');
  const stats = await text('.stat-n');
  assert.ok(Number(stats[0]) >= 1, 'sample has an error');

  // 2. Fix all safe issues -> only manual items remain
  await page.click('[data-action="fixall"]');
  await page.waitForFunction(() => /Fixed \d+ issue/.test(document.querySelector('.status')?.textContent || ''));
  await shot('2-after-fix-all.png');
  const left = await page.$$eval('.item', (els) => els.map((e) => e.textContent));
  assert.ok(left.every((t) => /Delete|Hidden layer|Empty layer|Larger than/.test(t)), `only manual items left, got: ${left.join(' | ')}`);
  assert.equal(await page.$('[data-action="fixall"]:not([disabled])'), null, 'no safe fixes remain');

  // 3. Variants
  await page.click('[data-tab="variants"]');
  await page.click('[data-action="pickall"]');
  await shot('3-variants.png');
  assert.equal((await page.$$('.card.on')).length, 8);
  assert.ok((await page.$$('.strat')).length >= 16, 'every card offers Same design / Anchored');
  const cut = await page.$$eval('.card-msg', (els) => els.map((e) => e.textContent).filter((t) => /cut off/.test(t)));
  assert.deepEqual(cut, [], 'no variant crops the design');

  // 3b. Choosing a strategy per card
  await page.click('.card:nth-of-type(4) .strat[data-k="fit"]');
  assert.ok(await page.$('.card:nth-of-type(4) .strat.on[data-k="fit"]'));

  // 3c. AI flow: gated on an API key
  assert.ok(await page.$('.ai-box [data-tab="brand"]'), 'AI is gated on an API key');
  await page.click('.ai-box [data-tab="brand"]');
  await page.fill('[data-field="ai-key"]', 'sk-ant-test');
  await page.dispatchEvent('[data-field="ai-key"]', 'change');
  await page.selectOption('[data-field="ai-model"]', 'claude-sonnet-5-5');
  await page.dispatchEvent('[data-field="ai-model"]', 'change');
  await page.click('[data-tab="variants"]');
  await page.click('[data-action="askai"]');
  await page.waitForFunction(() => /AI laid out 8 formats/.test(document.querySelector('.status')?.textContent || ''));
  const call = await page.evaluate(() => {
    const c = window.__fetchCalls[0];
    const t = c.body.messages[0].content[0].text;
    return { n: window.__fetchCalls.length, url: c.url, key: c.headers['x-api-key'], model: c.body.model, hasLayers: t.includes('"Headline"') };
  });
  assert.deepEqual(call, { n: 1, url: 'https://api.anthropic.com/v1/messages', key: 'sk-ant-test', model: 'claude-sonnet-5-5', hasLayers: true }, 'one request covers all formats');
  assert.equal((await page.$$('.strat[data-k="ai"]')).length, 8, 'every card now has an AI option');
  await page.click('.card:nth-of-type(4) .strat[data-k="ai"]');
  assert.ok(await page.$('.card:nth-of-type(4) .card-msg.ai'), 'AI rationale is shown when AI is selected');
  await shot('3b-variants-ai.png');
  assert.equal(await page.evaluate(() => JSON.stringify(window.__mock.log).includes('sk-ant')), false, 'key never reaches adapter calls');

  await page.click('[data-action="generate"]');
  await page.waitForFunction(() => /Created 8 variants/.test(document.querySelector('.status')?.textContent || ''));
  const calls = await page.evaluate(() => window.__mock.log.filter((l) => l[0] === 'createVariant').map((l) => l[1]));
  assert.equal(calls.length, 8);

  // 3d. The panel fills whatever size it is given (the "does not extend" bug)
  for (const [W, H] of [[260, 480], [340, 760], [640, 1000], [900, 700]]) {
    await page.setViewportSize({ width: W, height: H });
    await page.waitForTimeout(600);
    const m = await page.evaluate(() => {
      const r = (id) => document.getElementById(id).getBoundingClientRect();
      return { foot: r('foot'), view: r('view'), sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight };
    });
    assert.ok(Math.abs(m.foot.bottom - H) <= 1, `${W}x${H}: footer sits on the bottom edge (got ${m.foot.bottom})`);
    assert.ok(m.view.height >= 80, `${W}x${H}: scroll area has room`);
    assert.ok(m.sw <= W + 1, `${W}x${H}: no horizontal scrolling (${m.sw})`);
    assert.ok(m.sh <= H + 1, `${W}x${H}: page itself does not scroll (${m.sh})`);
  }
  await page.setViewportSize({ width: 640, height: 1000 });
  await page.waitForTimeout(600);
  await shot('3c-wide-panel.png');
  await page.setViewportSize({ width: 340, height: 760 });
  await page.waitForTimeout(600);

  // 4. Brand
  await page.click('[data-tab="brand"]');
  await shot('4-brand.png');
  await page.fill('[data-field="safeMarginPct"]', '10');
  await page.dispatchEvent('[data-field="safeMarginPct"]', 'change');
  assert.equal(await page.evaluate(() => window.__panel.state.spec.safeMarginPct), 10);

  // 5. No-document state
  await page.evaluate(() => { window.__mock.setDoc(null); return window.__panel.scan(); });
  await page.click('[data-tab="audit"]');
  await shot('5-empty.png');
  assert.ok((await text('.empty'))[0].includes('Open a document'));

  assert.deepEqual(errors, [], 'no console/page errors');
  await browser.close();
  console.log('UI smoke test passed; screenshots in', outDir);
}

main().catch((e) => { console.error(e); process.exit(1); });
