/* Shared CodeMirror 6 visual language for catio editors.
 *
 * Extracted from SqlEditor so the SQL console and the remote-file editor share
 * one source of truth — when the user switches theme color, both editors track
 * the same CSS vars and never drift. Pure style constants; no behavior. */
import { EditorView } from '@codemirror/view'
import { HighlightStyle } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

/* Token palette: keywords → --accent-primary (bold), strings → --signal-green,
 * numbers → --signal-amber, comments → --text-faint. Engine/language-agnostic. */
export const catioHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: 'var(--accent-primary)', fontWeight: '600' },
  { tag: [t.string, t.special(t.string)], color: 'var(--signal-green)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--signal-amber)' },
  { tag: [t.lineComment, t.blockComment], color: 'var(--text-faint)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--accent-primary)' },
  { tag: t.variableName, color: 'var(--text-primary)' },
  { tag: t.propertyName, color: 'var(--text-primary)' },
  { tag: [t.typeName, t.className], color: 'var(--text-primary)' },
  { tag: t.punctuation, color: 'var(--text-secondary)' },
])

/* Theme: 12px/14px padding, 13px Geist Mono, 1.6 line-height, transparent
 * background (host provides --surface-subtle), accent caret, themed gutter and
 * completion popup. All colors consume app CSS vars so they follow the theme. */
export const catioTheme = EditorView.theme(
  {
    '&': {
      backgroundColor: 'transparent',
      color: 'var(--text-primary)',
      fontSize: '13px',
      height: '100%',
      width: '100%',
    },
    '.cm-scroller': {
      fontFamily: "'Geist Mono', monospace",
      lineHeight: '1.6',
      overflow: 'auto',
      scrollbarWidth: 'thin',
    },
    '.cm-scroller::-webkit-scrollbar': { width: '10px', height: '10px' },
    '.cm-scroller::-webkit-scrollbar-thumb': {
      background: 'color-mix(in srgb, var(--text-faint) 40%, transparent)',
      borderRadius: '999px',
      border: '3px solid transparent',
      backgroundClip: 'padding-box',
    },
    '.cm-scroller::-webkit-scrollbar-thumb:hover': {
      background: 'color-mix(in srgb, var(--text-faint) 65%, transparent)',
      backgroundClip: 'padding-box',
    },
    '.cm-scroller::-webkit-scrollbar-corner': { background: 'transparent' },
    '.cm-content': {
      padding: '12px 14px',
      caretColor: 'var(--accent-primary)',
    },
    '.cm-line': { padding: '0' },
    '&.cm-focused': { outline: 'none' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent-primary)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'var(--accent-soft-alt, rgba(99,102,241,.22))',
    },
    '.cm-gutters': {
      background: 'transparent',
      border: 'none',
      color: 'var(--text-faint)',
    },
    '.cm-lineNumbers .cm-gutterElement': {
      padding: '0 6px 0 10px',
      fontSize: '12px',
      minWidth: '24px',
    },
    '.cm-activeLineGutter': { background: 'transparent', color: 'var(--text-secondary)' },
    '.cm-tooltip.cm-tooltip-autocomplete': {
      background: 'var(--surface-elevated)',
      border: '1px solid var(--border-hairline-alt)',
      borderRadius: '9px',
      boxShadow: 'var(--shadow-dropdown)',
      fontFamily: "'Geist Mono', monospace",
      fontSize: '12.5px',
    },
    '.cm-tooltip-autocomplete > ul': { maxHeight: '14em' },
    '.cm-tooltip-autocomplete > ul > li': { padding: '3px 8px', color: 'var(--text-secondary)' },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      background: 'var(--accent-soft-alt)',
      color: 'var(--accent-primary)',
    },
    '.cm-completionIcon': { opacity: 0.7, marginRight: '4px' },
    '.cm-completionMatchedText': { textDecoration: 'none', color: 'var(--accent-primary)', fontWeight: '600' },
  },
  { dark: true },
)
