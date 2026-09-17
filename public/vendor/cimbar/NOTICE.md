# CIMBAR offline encoder

- Upstream: https://github.com/sz3/libcimbar/tree/v0.6.8
- Release: https://github.com/sz3/libcimbar/releases/tag/v0.6.8
- Source archive: https://github.com/sz3/libcimbar/archive/refs/tags/v0.6.8.tar.gz
- Original `cimbar_js.html` SHA-256: `18be6cbbb3b990409af51732c1ec33a495e5cd83ad35d0ba1b64ee7a12abb309`
- `cimbar.js` is the unmodified fifth inline script from that release, containing the
  Emscripten runtime and embedded WASM. Its core is Mozilla Public License 2.0 (`LICENSE`).
- Dependency notices are in `licenses/`. Upstream sources retain their individual notices.
- Reproduce/update using `python3 scripts/vendor-cimbar.py` from the repository root.

`encoder.html` and `bridge.js` are Catio's separate host adapter. They select mode B,
preserve filenames as UTF-8, and use the upstream fountain/zstd protocol unchanged.
The upstream file picker, HTML filename interpolation, logs, PWA registration and
network links are not included. The sandboxed frame has no Tauri access, no same-origin
permission and a CSP blocking network connections. Removing the frame destroys its
WASM memory and animation loop. The white background and original code colors are
intentional optical protocol requirements, independent of the application theme.
