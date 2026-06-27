/* Generic CodeMirror 6 editor — the reusable core of SqlEditor without the SQL
 * coupling (no dialect, schema, JOIN completion, or selection toolbar). Used by
 * the remote-file editor; takes a language extension, plain value/onChange, and
 * a Ctrl/Cmd+S save hook. Shares catioTheme/catioHighlight so it tracks themes. */
import { useEffect, useRef } from 'react'
import { EditorView, keymap, placeholder as cmPlaceholder, lineNumbers, highlightActiveLineGutter } from '@codemirror/view'
import { EditorState, Compartment, type Extension } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { syntaxHighlighting, bracketMatching, indentOnInput } from '@codemirror/language'
import { catioTheme, catioHighlight } from './editorTheme'

export interface CodeEditorProps {
  value: string
  onChange: (value: string) => void
  /** Language extension for highlighting (from detectLang). null → plain text. */
  language?: Extension | null
  /** When true, the document is not editable (e.g. truncated read-only preview). */
  readOnly?: boolean
  /** Invoked on Ctrl/Cmd+S. */
  onSave?: () => void
  placeholder?: string
}

export function CodeEditor({ value, onChange, language, readOnly, onSave, placeholder }: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const langCompartment = useRef(new Compartment())
  const editCompartment = useRef(new Compartment())
  // Keep latest callbacks without re-running the mount effect.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave

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
          key: 'Mod-s',
          run: () => { onSaveRef.current?.(); return true },
          preventDefault: true,
        },
        ...closeBracketsKeymap,
        ...historyKeymap,
        ...defaultKeymap,
        indentWithTab,
      ]),
      langCompartment.current.of(language ?? []),
      editCompartment.current.of(EditorState.readOnly.of(!!readOnly)),
      EditorView.editable.of(!readOnly),
      EditorView.updateListener.of(update => {
        if (update.docChanged) onChangeRef.current(update.state.doc.toString())
      }),
    ]
    const view = new EditorView({
      state: EditorState.create({ doc: value, extensions }),
      parent: hostRef.current,
    })
    viewRef.current = view
    // Re-measure when the container goes from hidden (inactive tab) to visible.
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

  // Swap the language extension when the detected language changes.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: langCompartment.current.reconfigure(language ?? []) })
  }, [language])

  // Sync external value changes (e.g. a reload after conflict) without clobbering
  // the caret while the user types locally.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === value) return
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
  }, [value])

  return (
    <div ref={rootRef} className="col" style={{ position: 'relative', background: 'var(--surface-subtle)', height: '100%', width: '100%', overflow: 'hidden' }}>
      <div ref={hostRef} style={{ flex: 1, minHeight: 0, width: '100%', overflow: 'hidden' }} />
    </div>
  )
}
