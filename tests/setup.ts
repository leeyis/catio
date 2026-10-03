import '@testing-library/jest-dom'

// jsdom has no layout API for text ranges. CodeMirror tooltips still need these
// methods for its measurement cycle; actual placement is verified in a browser.
if (typeof Range !== 'undefined' && !Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
}
if (typeof Range !== 'undefined' && !Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = () => new DOMRect()
}
