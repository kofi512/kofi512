'use strict';
// A deliberately flawed 1080x1350 social post, used by tests and the browser preview.

const L = (id, name, kind, left, top, right, bottom, extra) => Object.assign(
  { id, name, kind, visible: true, locked: false, opacity: 100, empty: false, bounds: { left, top, right, bottom } },
  extra,
);

function sampleDoc() {
  return {
    name: 'summer-sale.psd',
    width: 1080,
    height: 1350,
    resolution: 72,
    colorMode: 'RGB',
    layers: [
      L('0', 'Shop now', 'text', 150, 1155, 460, 1205, {
        text: { content: 'Shop now', font: 'Montserrat-Bold', sizePx: 44, colorHex: '#FFFFFF' },
      }),
      L('1', 'CTA button', 'shape', 90, 1130, 520, 1230, { fillHex: '#E4572E' }),
      L('2', 'Headline', 'text', 90, 120, 990, 420, {
        text: { content: 'Summer sale\nup to 50% off', font: 'Montserrat-ExtraBold', sizePx: 120, colorHex: '#111111' },
      }),
      L('3', 'Subhead', 'text', 90, 460, 760, 560, {
        text: { content: 'Free delivery on every order this week', font: 'Comic Sans MS', sizePx: 40, colorHex: '#E85A30' },
      }),
      L('4', 'Fine print', 'text', 90, 1270, 700, 1300, {
        text: { content: 'Terms apply. See website for details.', font: 'Inter-Regular', sizePx: 18, colorHex: '#6B7280' },
      }),
      L('5', 'Logo', 'smart', -20, 40, 200, 100),
      L('6', 'Product shot', 'pixel', 300, 600, 1060, 1100),
      L('7', 'Layer 14', 'pixel', 0, 0, 0, 0, { empty: true, bounds: null }),
      L('8', 'Old headline', 'text', 90, 700, 900, 800, {
        visible: false,
        text: { content: 'WINTER CLEARANCE', font: 'Montserrat-Bold', sizePx: 80, colorHex: '#111111' },
      }),
      L('9', 'Background', 'solid', 0, 0, 1080, 1350, { fillHex: '#F4F1EA' }),
    ],
  };
}

module.exports = { sampleDoc };
