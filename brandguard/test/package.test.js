'use strict';
// Guards the things that make Photoshop refuse to load a plugin: manifest shape and referenced files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

test('manifest is a valid UXP v5 Photoshop panel', () => {
  assert.equal(manifest.manifestVersion, 5);
  assert.equal(manifest.host.app, 'PS');
  assert.ok(/^[\w.-]+$/.test(manifest.id));
  assert.ok(/^\d+\.\d+\.\d+$/.test(manifest.version));
  assert.equal(manifest.entrypoints[0].type, 'panel');
  assert.ok(manifest.entrypoints[0].minimumSize.width <= manifest.entrypoints[0].preferredDockedSize.width);
});

test('panel is resizable and only allowed to reach the Anthropic API', () => {
  const ep = manifest.entrypoints[0];
  assert.ok(ep.maximumSize.width >= 1000 && ep.maximumSize.height >= 1000, 'panel can be made large');
  assert.deepEqual(manifest.requiredPermissions.network.domains, ['https://api.anthropic.com']);
});

test('every file the manifest and index.html reference exists (incl. @2x icons)', () => {
  const exists = (p) => assert.ok(fs.existsSync(path.join(root, p)), `${p} missing`);
  exists(manifest.main);
  for (const ic of [...manifest.icons, ...manifest.entrypoints[0].icons]) {
    exists(ic.path);
    if ((ic.scale || []).includes(2)) exists(ic.path.replace('.png', '@2x.png'));
  }
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) exists(m[1]);
});

test('UI and core never touch Photoshop modules (only src/ps may)', () => {
  const walk = (d) => fs.readdirSync(path.join(root, d), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of [...walk('src/core'), ...walk('src/ui')].filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(!/require\(['"](photoshop|uxp)['"]\)/.test(src), `${f} requires a host module`);
  }
});

test('UXP-incompatible CSS is not used (grid, gap)', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert.ok(!/display:\s*grid/.test(css));
  assert.ok(!/(^|[\s;{])gap:/.test(css));
});
