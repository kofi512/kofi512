// Browser-side stand-in for api.anthropic.com, used only by dev/preview.js.
// It reads the request the panel sends and answers with a believable re-flow: for wide canvases
// the text/CTA/logo go in a left column and the picture on the right; otherwise everything is
// scaled into the safe area. Real answers come from Claude; this just exercises the UI flow.
window.__fetchCalls = [];
window.__fakeFetch = async function (url, init) {
  const body = JSON.parse(init.body);
  window.__fetchCalls.push({ url, headers: init.headers, body });
  const text = body.messages[0].content.find((c) => c.type === 'text').text;
  const data = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}\n\nReturn') + 1));
  const formats = data.formats.map((f) => {
    const wide = f.width / f.height > (data.source.width / data.source.height) * 1.2;
    const content = data.layers.filter((l) => l.role !== 'background');
    const textual = content.filter((l) => l.kind === 'text' || l.role === 'cta' || l.role === 'logo');
    let y = f.safe.top;
    const layers = data.layers.map((l) => {
      if (l.role === 'background') return { id: l.id, left: 0, top: 0, scale: 1, width: null, height: null };
      if (wide) {
        const colW = (f.safe.right - f.safe.left) * 0.5;
        if (textual.includes(l)) {
          const k = Math.min(1, colW / l.width) * 0.95;
          const out = { id: l.id, left: f.safe.left, top: y, scale: k, width: null, height: null };
          y += l.height * k + 12;
          return out;
        }
        const k = Math.min((f.safe.bottom - f.safe.top) / l.height, ((f.safe.right - f.safe.left) * 0.45) / l.width);
        return {
          id: l.id, left: f.safe.right - l.width * k,
          top: f.safe.top + ((f.safe.bottom - f.safe.top) - l.height * k) / 2, scale: k, width: null, height: null,
        };
      }
      const k = Math.min((f.safe.right - f.safe.left) / data.source.width, (f.safe.bottom - f.safe.top) / data.source.height);
      return { id: l.id, left: f.safe.left + l.left * k, top: f.safe.top + l.top * k, scale: k, width: null, height: null };
    });
    return {
      id: f.id,
      rationale: wide ? 'Text column on the left, product on the right.' : 'Stacked top to bottom, scaled to the safe area.',
      layers,
    };
  });
  const payload = JSON.stringify({ formats });
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: payload }], usage: { input_tokens: 10, output_tokens: 10 } }),
  };
};
