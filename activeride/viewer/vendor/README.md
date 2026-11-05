# Vendored libraries

| File | Library | Version | Licence |
|---|---|---|---|
| `three.bundle.min.js` | [three.js](https://threejs.org) core + `examples/jsm/controls/OrbitControls.js` | 0.160.0 (npm) | MIT, see `three.LICENSE` |

The bundle is an IIFE build (so the viewer works from `file://` with no server)
produced by `scripts/build_vendor.sh` with esbuild 0.20.2; it exposes
`window.THREE` and `window.THREE_OrbitControls`. No other third-party code is used.
