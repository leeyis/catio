// Load before App and its dependencies: xterm uses structuredClone in its
// constructor and reset(), but Edge/Chromium < 98 do not provide it.
// Use the standard polyfill (including undefined/cycles), not a JSON round-trip.
import 'core-js/actual/structured-clone'
