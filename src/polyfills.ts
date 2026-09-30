// Load before App and its dependencies. Vite's target transforms syntax but
// cannot supply missing runtime APIs used by dependencies on Edge 90:
// - react-markdown uses Object.hasOwn while rendering any Agent reply (Edge 93+).
// - xterm uses structuredClone in its constructor and reset() (Edge 98+).
// Use standard polyfills, including structuredClone's undefined/cycle support.
import 'core-js/actual/object/has-own'
import 'core-js/actual/structured-clone'
