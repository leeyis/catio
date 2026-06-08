/* CodeMirror 6 SQL editor with schema-aware autocomplete (IntelliSense).
 * Replaces the former textarea + highlightSQL overlay. Keeps the original
 * prop surface (code/onChange/minHeight/target) and visual language (Geist
 * Mono, 13px, app CSS vars) so callers and the design stay intact, and adds an
 * optional `schema` map (table → columns) wired into @codemirror/lang-sql. */
import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EditorView, keymap } from '@codemirror/view'
import { EditorState, Compartment, type Extension } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { sql, PostgreSQL, MySQL, SQLite, MSSQL, type SQLDialect } from '@codemirror/lang-sql'
import { Icon } from '../Icon'

export interface SqlEditorProps {
  code: string
  onChange: (value: string) => void
  minHeight?: number
  target?: string
  /** table name → column names, for schema-aware completion. Keys may be bare
   * (`orders`) or qualified (`public.orders`); lang-sql matches both. */
  schema?: Record<string, string[]>
  /** Invoked on Cmd/Ctrl+Enter (the "run query" shortcut). */
  onRun?: () => void
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
    '.cm-gutters': { display: 'none' },
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

export function SqlEditor({ code, onChange, minHeight, target = 'prod-orders', schema, onRun }: SqlEditorProps) {
  const { t: tr } = useTranslation()
  const hostRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const sqlCompartment = useRef(new Compartment())
  // Keep the latest callbacks without re-running the mount effect.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onRunRef = useRef(onRun)
  onRunRef.current = onRun
  const [selBar, setSelBar] = useState<{ left: number; top: number; text: string } | null>(null)

  // Mount once.
  useEffect(() => {
    if (!hostRef.current) return
    const extensions: Extension[] = [
      history(),
      bracketMatching(),
      closeBrackets(),
      indentOnInput(),
      autocompletion(),
      syntaxHighlighting(catioHighlight),
      catioTheme,
      keymap.of([
        {
          key: 'Mod-Enter',
          run: () => { onRunRef.current?.(); return true },
          preventDefault: true,
        },
        ...closeBracketsKeymap,
        ...completionKeymap,
        ...historyKeymap,
        ...defaultKeymap,
        indentWithTab,
      ]),
      sqlCompartment.current.of(sql({ dialect: PostgreSQL, upperCaseKeywords: true })),
      EditorView.updateListener.of(update => {
        if (update.docChanged) {
          onChangeRef.current(update.state.doc.toString())
        }
        if (update.selectionSet || update.docChanged) {
          // Hide the selection toolbar on any caret movement / edit; mouseup re-shows it.
          setSelBar(null)
        }
      }),
    ]
    const view = new EditorView({
      state: EditorState.create({ doc: code, extensions }),
      parent: hostRef.current,
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Reconfigure the sql() extension when the schema changes (compartment swap).
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: sqlCompartment.current.reconfigure(
        sql({ dialect: PostgreSQL, schema, upperCaseKeywords: true }),
      ),
    })
  }, [schema])

  // Sync external `code` changes (e.g. AI-inserted SQL, Clear button) into the
  // doc without clobbering the cursor while the user types locally.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === code) return
    view.dispatch({ changes: { from: 0, to: current.length, insert: code } })
  }, [code])

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
    const left = (e.clientX - rootRect.left) / scale
    const top = (e.clientY - rootRect.top) / scale
    setSelBar({ left, top, text: text.trim() })
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
    <div ref={rootRef} style={{ position: 'relative', background: 'var(--surface-subtle)', minHeight: minHeight || 0, height: '100%', overflow: 'hidden' }}>
      <div ref={hostRef} onMouseUp={onMouseUp} onMouseDown={() => setSelBar(null)} style={{ height: '100%' }} />
      {/* selection toolbar — copy / ask AI */}
      {selBar && (
        <div className="row gap2 pop-in" style={{ position: 'absolute', left: selBar.left, top: selBar.top - 10, transform: 'translate(-50%, -100%)', zIndex: 30, background: 'var(--surface-elevated)', border: '1px solid var(--border-hairline-alt)', borderRadius: 9, boxShadow: 'var(--shadow-dropdown)', padding: 3 }}>
          <button className="row gap5 sel-pill" onMouseDown={e => e.preventDefault()} onClick={copySel}
            style={{ height: 27, padding: '0 10px', borderRadius: 7, fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
            <Icon name="copy" size={13} /> {tr('dbviews.copySel')}
          </button>
          <div style={{ width: 1, background: 'var(--border-hairline)', margin: '3px 1px' }} />
          <button className="row gap5 sel-pill" onMouseDown={e => e.preventDefault()} onClick={askSelAI}
            style={{ height: 27, padding: '0 10px', borderRadius: 7, fontSize: 12, fontWeight: 600, color: 'var(--accent-primary)' }}>
            <Icon name="sparkles" size={13} /> {tr('dbviews.askAI')}
          </button>
          <span style={{ position: 'absolute', left: '50%', bottom: -5, transform: 'translateX(-50%) rotate(45deg)', width: 8, height: 8, background: 'var(--surface-elevated)', borderRight: '1px solid var(--border-hairline-alt)', borderBottom: '1px solid var(--border-hairline-alt)' }} />
        </div>
      )}
    </div>
  )
}
