// Stand-in for modules the engine never uses (image decoding via sharp, the browser ONNX runtime).
module.exports = new Proxy(function () {}, {
  get: (_t, k) => (k === '__esModule' ? false : k === 'default' ? module.exports : () => { throw new Error('Not available in the Kea engine.'); }),
  apply: () => { throw new Error('Not available in the Kea engine.'); }
});
