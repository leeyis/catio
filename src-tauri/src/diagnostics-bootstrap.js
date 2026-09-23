// Injected by Tauri before any page scripts. Keep ES5 syntax and no dependencies:
// even a main-bundle parse/import failure must be reported to the native logger.
;(function () {
  if (window.top && window.top !== window) return;
  if (window.__CATIO_DIAGNOSTICS__) return;
  var queue = [], sending = false, retry = 0, count = 0, since = Date.now();
  var types = ['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'URIError', 'EvalError', 'DOMException'];

  function frames(error, filename, line, column) {
    var text = '';
    try { text = typeof error.stack === 'string' ? error.stack : ''; } catch (_) {}
    if (filename) text += '\n' + filename + ':' + (line || 0) + ':' + (column || 0);
    // Keep only code locations in our bundle/source tree, never URL authorities,
    // query strings, exception messages, arbitrary rejection objects or paths.
    var matches = text.match(/(?:assets\/[A-Za-z0-9_-]+\.js|src\/[A-Za-z0-9_./-]+\.[jt]sx?):[0-9]{1,8}:[0-9]{1,8}/g) || [];
    return matches.filter(function (s) { return s.length <= 240 && s.indexOf('..') < 0; }).slice(0, 12);
  }

  function flush() {
    if (sending || !queue.length) return;
    sending = true;
    try {
      window.__TAURI_INTERNALS__.invoke('diagnostics_runtime_log', { event: queue[0] }).then(function () {
        queue.shift(); sending = false; retry = 0; flush();
      }, failed);
    } catch (_) { failed(); }
  }
  function failed() {
    sending = false;
    // Bounded retries; logging must not cause unhandled rejection recursion.
    if (++retry <= 3) setTimeout(flush, retry * 1000);
    else { queue.shift(); retry = 0; if (queue.length) setTimeout(flush, 1000); }
  }

  function report(event, error, operation, filename, line, column) {
    if (Date.now() - since >= 60000) { since = Date.now(); count = 0; }
    if (++count > 100 || queue.length >= 40) return;
    var name = 'Unknown', message = '';
    try {
      if (error && types.indexOf(error.name) >= 0) name = error.name;
      if (error && typeof error.message === 'string') message = error.message.slice(0, 4096);
    } catch (_) {}
    var code = 'unknown';
    if (/structuredClone.*(?:not defined|not a function)/.test(message)) code = 'missing-structuredClone';
    else if (/randomUUID.*(?:not defined|not a function)/.test(message)) code = 'missing-randomUUID';
    else if (/dynamically imported module|module script|Loading chunk/.test(message)) code = 'module-load-failed';
    else if (/permission|not allowed|access denied/i.test(message)) code = 'permission-denied';
    else if (/Failed to fetch|NetworkError|network request/i.test(message)) code = 'network-error';
    var data = { event: event, errorType: name, code: code, frames: frames(error, filename, line, column) };
    if (typeof operation === 'string' && /^[a-z_]{1,80}$/.test(operation)) data.operation = operation;
    queue.push(data); flush();
  }
  window.__CATIO_DIAGNOSTICS__ = { report: report };
  window.addEventListener('error', function (e) {
    if (e.target && e.target !== window) {
      // Do not serialize failed resource URLs (they can include credentials).
      report('resource-error');
    } else {
      report('javascript-error', e.error || { message: e.message }, undefined, e.filename, e.lineno, e.colno);
    }
  }, true);
  window.addEventListener('unhandledrejection', function (e) { report('unhandled-rejection', e.reason); });
  report('frontend-started');
}());
