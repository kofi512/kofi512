# BrandGuard — Preflight & Variants for Photoshop

A UXP panel that fills the gap between *making* a design and *shipping* it: it audits the open
document against a brand spec, fixes what is safe to fix, and re-lays the design out for every
format you publish in.

| Tab | What it does |
| --- | --- |
| **Preflight** | Checks fonts, palette (ΔE), safe zone, minimum text size, WCAG contrast, colour mode, resolution and layer hygiene. Each finding has *Select layer* and a one-click fix. **Fix N safe issues** applies everything non-destructive as a single undo step. Deleting layers is never automatic. |
| **Variants** | Re-lays out the design for each format (Instagram, Story, LinkedIn, banners…) using anchors, creates each as a new document and optionally exports PNGs. Wireframe thumbnails and the safe zone show the result *before* anything is created; the same preflight rules validate every variant. |
| **Brand** | Palette, fonts, thresholds and formats. Import/export the spec as JSON to share it with a team. |

## How variants are laid out

Every format is planned three ways, each plan is simulated and scored by the same preflight rules,
and the best one is selected. You can switch any card between them.

| Strategy | What it does |
| --- | --- |
| **Same design** | Scales the *whole* design uniformly and centres it; backgrounds are extended to fill the new canvas. Nothing is cropped or rearranged — the guaranteed-complete option. |
| **Anchored** | Keeps each layer pinned to the edge it was nearest to (or centred) with margins scaled, so the new canvas is used better. Layers that were fully inside the source stay fully inside the target. |
| **AI** | Claude looks at a picture of your design plus the layer list and proposes a re-flow per format (e.g. portrait → text column + product for landscape). The answer is validated: forgotten layers keep the same-design transform, backgrounds are forced to cover, content is pulled back into the safe zone, and it is scored against the other two. |

Scoring punishes cut-off content hardest, then safe-zone / text-size / contrast problems and new
overlaps, and rewards using more of the canvas. Layers that overlap in the source (a button and its
label) always move as one cluster.

### AI setup (optional)

Brand tab → **AI layout**: paste an Anthropic API key and pick a model (default Claude Opus 5.5).
The key is stored in the plugin's local storage, sent only to `api.anthropic.com`, and is never part of
an exported brand spec. When you use AI, a JPEG of the open document and its layer names/text are sent.
Without a key everything else still works.

## Layout

```
brandguard/
├── manifest.json        UXP v5 panel manifest
├── index.html / index.js / styles.css
├── src/core/            pure JS, no Photoshop: color, spec, roles, rules (audit + fixes), variants, ai
├── src/ui/app.js        the panel (renders strings, event delegation, no framework)
├── src/ps/adapter.js    the ONLY file that talks to Photoshop
├── dev/                 mock adapter, sample document, browser preview / UI smoke test
└── test/                node:test unit tests + manifest checks
```

The panel only talks to an *adapter* (`readDocument`, `applyFixes`, `createVariant`, …), so everything
except `src/ps/adapter.js` runs and is tested without Photoshop.

## Develop

```bash
npm test              # unit tests: rules, fixes, variant engine, manifest
npm run preview       # builds dev/out/preview.html, clicks through the real panel with the mock
                      # adapter in Chromium (if Playwright is installed) and writes screenshots
```

### Load it in Photoshop

1. Photoshop 24.2 (2023) or newer, and Adobe's **UXP Developer Tool** (Creative Cloud app).
2. In the Developer Tool: *Add Plugin…* → select `brandguard/manifest.json` → *Load*.
3. In Photoshop: *Plugins › BrandGuard*.

## Status — please read

`src/ps/adapter.js` was written against the UXP Photoshop DOM but **has not been run inside Photoshop**
(there is no Photoshop in the build environment). Everything else is covered by tests, but expect to
shake out adapter details on first load. The riskiest bits, in order:

* **Text size units** — reads `characterStyle.size` as points and converts with `resolution / 72`.
* **Solid-colour layers** — fill colour is read/written through `batchPlay` (`adjustment[0].color`).
* **`Document.duplicate` + `resizeCanvas`** for variants, and re-positioning via `layer.bounds` + `translate`.
* **Font names** — `setFont` needs a PostScript name Photoshop has installed (e.g. `Montserrat-Bold`).
* **Layer transforms** — variants scale every layer with `layer.scale(%, %)` (like Free Transform) and then translate using the re-read `layer.bounds`.
* **AI preview image** — rendered with `imaging.getPixels` + `encodeImageData`; if that fails the AI step still works from layer data alone.

Not done yet: Arabic/RTL text checks, real re-flow between very different aspect ratios, artboard
output (variants are separate documents), per-layer role overrides in the UI.

## Install

Download `dist/BrandGuard.ccx` (v0.2.0; rebuild with `npm run package`), then either:

* **Double-click the `.ccx`** — Creative Cloud installs it. Unsigned plugins may show an
  "unverified" notice; accept it. Then open *Plugins › BrandGuard* in Photoshop.
* **Or** load `manifest.json` from the folder with Adobe's UXP Developer Tool (*Add Plugin…* → *Load*),
  which also shows error logs if something fails.
