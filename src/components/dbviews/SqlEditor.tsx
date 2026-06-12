/* CodeMirror 6 SQL editor with schema-aware autocomplete (IntelliSense).
 * Replaces the former textarea + highlightSQL overlay. Keeps the original
 * prop surface (code/onChange/minHeight/target) and visual language (Geist
 * Mono, 13px, app CSS vars) so callers and the design stay intact, and adds an
 * optional `schema` map (table → columns) wired into @codemirror/lang-sql. */
import React, { useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react'
import { useTranslation } from 'react-i18next'
import { EditorView, keymap, placeholder as cmPlaceholder, lineNumbers, highlightActiveLineGutter } from '@codemirror/view'
import { EditorState, Compartment, type Extension } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, type CompletionSource } from '@codemirror/autocomplete'
import { syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { sql, PostgreSQL, MySQL, SQLite, MSSQL, type SQLDialect, type SQLNamespace } from '@codemirror/lang-sql'
import { Icon } from '../Icon'
import { editorStats, type EditorStats } from './editorStats'

export interface SqlEditorProps {
  code: string
  onChange: (value: string) => void
  minHeight?: number
  target?: string
  /** Nested completion data in lang-sql's `SQLNamespace` shape (schemas →
   * tables → columns). The nesting lets lang-sql assign distinct completion
   * types/icons to schemas, tables, and columns. */
  schema?: SQLNamespace
  /** Invoked on Alt+Enter (the "run query" shortcut). */
  onRun?: () => void
  /** Run just the currently-selected SQL (from the selection toolbar or Alt+Enter with a selection). */
  onRunSelection?: (sql: string) => void
  /** 空文档占位提示(mongo/es 控制台展示各自语法示例)。 */
  placeholder?: string
  /** true → 非 SQL 模式:不挂 lang-sql(无 SQL 补全),用于 mongo/es 控制台。 */
  plain?: boolean
  /** plain 模式下的自定义补全源(如 mongo shell 补全)。非 plain 时忽略。 */
  completion?: CompletionSource
}

/** Imperative handle exposed to parents (e.g. SqlConsole) for cursor-aware
 * insertion of snippet / history / AI text into the live CodeMirror doc. */
export interface SqlEditorHandle {
  /**
   * Insert `text` at the current caret position (replacing any selection),
   * using the CodeMirror view so the user's cursor/scroll are respected.
   * When `newLine` is true, a leading '\n' is prepended unless the caret is
   * already at the start of a line (so a "run" lands the SQL on its own line).
   * Moves the caret to the end of the inserted text and focuses the editor.
   * Returns the resulting full document text (so callers can run it).
   */
  insertAtCursor: (text: string, newLine?: boolean) => string
}

/** Map a backend engine name to a lang-sql dialect (default PostgreSQL). */
export function dialectFor(dbType?: string): SQLDialect {
  switch (dbType) {
    case 'mysql': return MySQL
    case 'sqlite': case 'duckdb': return SQLite
    case 'sqlserver': return MSSQL
    default: return PostgreSQL
  }
}

/* Token palette mirrors the former highlightSQL.ts so the look is unchanged:
 * keywords → --accent-primary (bold), strings → --signal-green,
 * numbers → --signal-amber, comments → --text-faint. */
const catioHighlight = HighlightStyle.define([
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

/* Theme replicating the original layer: 12px/14px padding, 13px Geist Mono,
 * 1.6 line-height, transparent background (host provides --surface-subtle),
 * accent caret, no gutter (the original had none). */
const catioTheme = EditorView.theme(
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
    },
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
    // Line-number gutter — themed to the app's dim tokens (was hidden before).
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
    // Completion popup — match the app's elevated surface tokens.
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

export const SqlEditor = forwardRef<SqlEditorHandle, SqlEditorProps>(function SqlEditor(
  { code, onChange, minHeight, target = 'prod-orders', schema, onRun, onRunSelection, placeholder, plain, completion },
  ref,
) {
  const { t: tr } = useTranslation()
  const hostRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const sqlCompartment = useRef(new Compartment())
  // Build the language/completion extension for the SQL compartment. Plain mode
  // (mongo/es) drops lang-sql; it gets a custom completion source when provided.
  function langExt(): Extension {
    if (plain) return completion ? autocompletion({ override: [completion] }) : []
    return [sql({ dialect: PostgreSQL, schema, upperCaseKeywords: true }), autocompletion()]
  }
  // Keep the latest callbacks without re-running the mount effect.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onRunRef = useRef(onRun)
  onRunRef.current = onRun
  const onRunSelectionRef = useRef(onRunSelection)
  onRunSelectionRef.current = onRunSelection
  const [selBar, setSelBar] = useState<{ left: number; top: number; text: string; below: boolean } | null>(null)
  const [stats, setStats] = useState<EditorStats>(() => editorStats(code, 0))

  // Mount once.
  useEffect(() => {
    if (!hostRef.current) return
    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      history(),
      bracketMatching(),
      closeBrackets(),
      indentOnInput(),
      syntaxHighlighting(catioHighlight),
      catioTheme,
      ...(placeholder ? [cmPlaceholder(placeholder)] : []),
      keymap.of([
        {
          key: 'Alt-Enter',
          run: view => {
            const sel = view.state.selection.main
            if (!sel.empty && onRunSelectionRef.current) {
              const text = view.state.sliceDoc(sel.from, sel.to).trim()
              if (text) {
                onRunSelectionRef.current(text)
                setSelBar(null)
                return true
              }
            }
            onRunRef.current?.()
            setSelBar(null)
            return true
          },
          preventDefault: true,
        },
        ...closeBracketsKeymap,
        ...completionKeymap,
        ...historyKeymap,
        ...defaultKeymap,
        indentWithTab,
      ]),
      sqlCompartment.current.of(langExt()),
      EditorView.updateListener.of(update => {
        if (update.docChanged) {
          onChangeRef.current(update.state.doc.toString())
        }
        if (update.selectionSet || update.docChanged) {
          // Hide the selection toolbar on any caret movement / edit; mouseup re-shows it.
          setSelBar(null)
          // Refresh the status-bar stats (line count / chars / caret line:col).
          const s = update.state
          setStats(editorStats(s.doc.toString(), s.selection.main.head))
        }
      }),
    ]
    const view = new EditorView({
      state: EditorState.create({ doc: code, extensions }),
      parent: hostRef.current,
    })
    viewRef.current = view
    // CodeMirror does not auto-re-measure when its container goes from hidden
    // (display:none / zero width — e.g. an inactive query tab) to visible, which
    // left the editor rendered at a collapsed width. Observe size changes and
    // request a re-measure so it always fills the available width.
    let ro: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined' && rootRef.current) {
      ro = new ResizeObserver(() => viewRef.current?.requestMeasure())
      ro.observe(rootRef.current)
    }
    return () => {
      ro?.disconnect()
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Reconfigure the language/completion extension when schema, plain mode, or
  // the custom completion source changes (compartment swap).
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: sqlCompartment.current.reconfigure(langExt()) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema, plain, completion])

  // Sync external `code` changes (e.g. AI-inserted SQL, Clear button) into the
  // doc without clobbering the cursor while the user types locally.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === code) return
    view.dispatch({ changes: { from: 0, to: current.length, insert: code } })
  }, [code])

  // Expose cursor-aware insertion to the parent (SqlConsole forwards snippet /
  // history / AI events here). Uses replaceSelection so insertion happens at the
  // caret / replaces a selection, then keeps the caret after the inserted text.
  useImperativeHandle(ref, () => ({
    insertAtCursor(text: string, newLine?: boolean) {
      const view = viewRef.current
      if (!view) return code
      let insert = text
      if (newLine) {
        const head = view.state.selection.main.from
        // Prepend a newline unless the caret is already at the start of a line
        // (column 0) — so a "run" always lands the SQL on its own fresh line.
        const col = head - view.state.doc.lineAt(head).from
        if (col > 0) insert = '\n' + text
      }
      // replaceSelection inserts at the caret (or replaces the active selection)
      // and leaves the caret at the end of the inserted text.
      view.dispatch(view.state.replaceSelection(insert))
      const next = view.state.doc.toString()
      // Keep React `code` in sync (the updateListener also fires, but return the
      // fresh doc so the caller can run it synchronously).
      onChangeRef.current(next)
      try { view.focus() } catch { /* best-effort */ }
      return next
    },
  }), [code])

  function onMouseUp(e: React.MouseEvent<HTMLDivElement>) {
    const view = viewRef.current
    const root = rootRef.current
    if (!view || !root) return
    const sel = view.state.selection.main
    if (sel.empty) { setSelBar(null); return }
    const text = view.state.sliceDoc(sel.from, sel.to)
    if (!text || !text.trim()) { setSelBar(null); return }
    const rootRect = root.getBoundingClientRect()
    const scale = (rootRect.width / root.offsetWidth) || 1
    const rawLeft = (e.clientX - rootRect.left) / scale
    const top = (e.clientY - rootRect.top) / scale
    // Dynamic placement: the bar is ~33px tall and sits ABOVE the cursor by default.
    // If there isn't room above (near the top), flip it BELOW. Clamp horizontally so
    // it never gets clipped by the editor's overflow:hidden.
    const below = top < 48
    const left = Math.max(86, Math.min(rawLeft, root.offsetWidth - 86))
    setSelBar({ left, top, text: text.trim(), below })
  }
  function runSel() {
    if (selBar) onRunSelection?.(selBar.text)
    setSelBar(null)
  }
  function copySel() {
    if (selBar && navigator.clipboard) navigator.clipboard.writeText(selBar.text).catch(() => {})
    setSelBar(null)
  }
  function askSelAI() {
    if (selBar) window.dispatchEvent(new CustomEvent('catio-ask-ai', { detail: { text: selBar.text, target, kind: 'sql' } }))
    setSelBar(null)
  }

  return (
    <div ref={rootRef} className="col" style={{ position: 'relative', background: 'var(--surface-subtle)', minHeight: minHeight || 0, height: '100%', width: '100%', overflow: 'hidden' }}>
      <div ref={hostRef} onMouseUp={onMouseUp} onMouseDown={() => setSelBar(null)} style={{ flex: 1, minHeight: 0, width: '100%', overflow: 'hidden' }} />
      {/* selection toolbar — copy / ask AI / run. Flips below the cursor when there
          isn't room above, and is clamped horizontally, so it's never clipped. */}
      {selBar && (
        <div className="row gap2 pop-in" style={{ position: 'absolute', left: selBar.left, top: selBar.below ? selBar.top + 18 : selBar.top - 10, transform: selBar.below ? 'translate(-50%, 0)' : 'translate(-50%, -100%)', zIndex: 30, background: 'var(--surface-elevated)', border: '1px solid var(--border-hairline-alt)', borderRadius: 9, boxShadow: 'var(--shadow-dropdown)', padding: 3 }}>
          <button className="row gap5 sel-pill" onMouseDown={e => e.preventDefault()} onClick={copySel}
            style={{ height: 27, padding: '0 10px', borderRadius: 7, fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
            <Icon name="copy" size={13} /> {tr('dbviews.copySel')}
          </button>
          <div style={{ width: 1, background: 'var(--border-hairline)', margin: '3px 1px' }} />
          <button className="row gap5 sel-pill" onMouseDown={e => e.preventDefault()} onClick={askSelAI}
            style={{ height: 27, padding: '0 10px', borderRadius: 7, fontSize: 12, fontWeight: 600, color: 'var(--accent-primary)' }}>
            <Icon name="wand" size={13} /> {tr('dbviews.askAI')}
          </button>
          {onRunSelection && <>
            <div style={{ width: 1, background: 'var(--border-hairline)', margin: '3px 1px' }} />
            <button className="row gap5 sel-pill" onMouseDown={e => e.preventDefault()} onClick={runSel}
              style={{ height: 27, padding: '0 10px', borderRadius: 7, fontSize: 12, fontWeight: 600, color: 'var(--signal-green)' }}>
              <Icon name="play" size={13} /> {tr('dbviews.runSelection')}
            </button>
          </>}
          {/* caret: points down when above the cursor, up when below */}
          <span style={{ position: 'absolute', left: '50%', ...(selBar.below ? { top: -5 } : { bottom: -5 }), transform: 'translateX(-50%) rotate(45deg)', width: 8, height: 8, background: 'var(--surface-elevated)', borderRight: '1px solid var(--border-hairline-alt)', borderBottom: '1px solid var(--border-hairline-alt)' }} />
        </div>
      )}
      {/* status bar — caret line:col · line count · char count (engine-agnostic) */}
      <div className="row" style={{ flex: 'none', justifyContent: 'flex-end', padding: '3px 12px', borderTop: '1px solid var(--border-hairline)', background: 'var(--surface-subtle)', fontSize: 11, color: 'var(--text-faint)', fontFamily: "'Geist Mono', monospace", userSelect: 'none' }}>
        {tr('dbviews.editorStats', { line: stats.line, col: stats.col, lines: stats.lines, chars: stats.chars })}
      </div>
    </div>
  )
})
