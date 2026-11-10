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

1. Roles are inferred per layer (background, headline, body, CTA, logo, image, graphic) from names
   (`logo`, `cta`, `bg`…), geometry and text size.
2. One content scale is chosen so the content block fits the target's safe area.
3. Every layer keeps the edge it was anchored to (left/right/top/bottom or centred).
4. Backgrounds cover the canvas; full-width bars stretch; text and logos are clamped inside the safe zone
   (per-format overrides, e.g. Story keeps the top 14 % and bottom 20 % clear).
5. Layers that overlap in the source (a button and its label) move as one **cluster**; clusters that
   collide after clamping are stacked apart again.
6. Layouts that cannot work (extreme aspect ratios, new overlaps, text that would become tiny) are
   **flagged, not hidden**. This is scale-and-anchor, not a full re-flow — a portrait → 1.91:1 conversion
   will often need a hand-made layout and the panel tells you so.

## Layout

```
brandguard/
├── manifest.json        UXP v5 panel manifest
├── index.html / index.js / styles.css
├── src/core/            pure JS, no Photoshop: color, spec, roles, rules (audit + fixes), variants
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
* **Layer scale for text** — text variants change font *size* rather than scaling the layer transform.

Not done yet: Arabic/RTL text checks, real re-flow between very different aspect ratios, artboard
output (variants are separate documents), per-layer role overrides in the UI.

## Install

Download `dist/BrandGuard.ccx` (rebuild with `npm run package`), then either:

* **Double-click the `.ccx`** — Creative Cloud installs it. Unsigned plugins may show an
  "unverified" notice; accept it. Then open *Plugins › BrandGuard* in Photoshop.
* **Or** load `manifest.json` from the folder with Adobe's UXP Developer Tool (*Add Plugin…* → *Load*),
  which also shows error logs if something fails.
