/* Catio adapter for libcimbar v0.6.8. No network, storage, file picker or privileged API. */
/* global Module */
var Module = {
  canvas: document.getElementById('canvas'),
  print: function () {},
  printErr: function () {},
  onAbort: function () { report('error', 'optical.encoderFailed'); },
  onRuntimeInitialized: function () {
    try {
      if (Module._cimbare_init_window(0, 0) < 0 || Module._cimbare_configure(68, -1) < 0) throw new Error();
      initialized = true;
      report('ready');
    } catch (_) { report('error', 'optical.encoderFailed'); }
  }
};
var initialized = false;
var loaded = false;
var loading = false;
var paused = true;
var requestId = '';
var frameHandle = 0;
var lastFrame = 0;

function report(type, error) {
  parent.postMessage({ channel: 'catio-cimbar', type: type, requestId: requestId, error: error }, '*');
}
function stop() { paused = true; cancelAnimationFrame(frameHandle); frameHandle = 0; }
function renderFrame(timestamp) {
  if (paused) return;
  try {
    if (timestamp - lastFrame >= 1000 / 15) {
      if (Module._cimbare_next_frame(0) < 0 || Module._cimbare_render() < 0) throw new Error();
      lastFrame = timestamp;
    }
    frameHandle = requestAnimationFrame(renderFrame);
  } catch (_) { stop(); report('error', 'optical.encoderFailed'); }
}
function play() { if (!loaded || !paused) return; paused = false; lastFrame = 0; frameHandle = requestAnimationFrame(renderFrame); }

async function encode(name, buffer) {
  loading = true;
  var ptr = 0;
  try {
    var filename = new TextEncoder().encode(name);
    ptr = Module._malloc(filename.length || 1);
    if (!ptr) throw new Error();
    Module.HEAPU8.set(filename, ptr);
    if (Module._cimbare_init_encode(ptr, filename.length, -1) < 0) throw new Error();
    Module._free(ptr); ptr = 0;
    var chunkSize = Module._cimbare_encode_bufsize() * 16;
    ptr = Module._malloc(chunkSize);
    if (!ptr) throw new Error();
    var bytes = new Uint8Array(buffer);
    var result = 1;
    for (var offset = 0; offset < bytes.length; offset += chunkSize) {
      var chunk = bytes.subarray(offset, offset + chunkSize);
      Module.HEAPU8.set(chunk, ptr);
      result = Module._cimbare_encode(ptr, chunk.length);
      if (result < 0) throw new Error();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    // Only flush when the last write was an exact chunk multiple (or an empty file).
    if (result > 0 && Module._cimbare_encode(ptr, 0) !== 0) throw new Error();
    bytes.fill(0);
    loaded = true;
    report('loaded');
    play();
  } catch (_) { report('error', 'optical.encoderFailed'); }
  finally { if (ptr) Module._free(ptr); loading = false; }
}

window.addEventListener('message', function (event) {
  if (event.source !== parent || !event.data || event.data.channel !== 'catio-cimbar') return;
  var message = event.data;
  if (message.type === 'load') {
    if (!initialized || loading || loaded || typeof message.requestId !== 'string') return;
    requestId = message.requestId;
    if (!(message.buffer instanceof ArrayBuffer) || message.buffer.byteLength > 5 * 1024 * 1024 ||
        typeof message.name !== 'string' || new TextEncoder().encode(message.name).length > 1024 || /[\x00/\\]/.test(message.name)) {
      report('error', 'optical.invalidRequest'); return;
    }
    void encode(message.name, message.buffer);
  } else if (message.requestId === requestId) {
    if (message.type === 'pause') { stop(); report('paused'); }
    if (message.type === 'play') { play(); report('playing'); }
  }
});
document.addEventListener('visibilitychange', function () {
  if (document.hidden && loaded) { stop(); report('paused'); }
});
Module.canvas.addEventListener('webglcontextlost', function (event) {
  event.preventDefault(); stop(); report('error', 'optical.encoderFailed');
});
