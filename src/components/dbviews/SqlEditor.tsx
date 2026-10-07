/* CodeMirror 6 SQL editor with schema-aware autocomplete (IntelliSense).
 * Replaces the former textarea + highlightSQL overlay. Keeps the original
 * prop surface (code/onChange/minHeight/target) and visual language (Geist
 * Mono, 13px, app CSS vars) so callers and the design stay intact, and adds an
 * optional `schema` map (table → columns) wired into @codemirror/lang-sql. */
import React, { useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react'
import { useTranslation } from 'react-i18next'
import { EditorView, keymap, placeholder as cmPlaceholder, lineNumbers, highlightActiveLineGutter } from '@codemirror/view'
import { EditorState, Compartment, Prec, type Extension } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { search,searchKeymap,openSearchPanel,closeSearchPanel,searchPanelOpen } from '@codemirror/search'
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, acceptCompletion, startCompletion, type CompletionSource } from '@codemirror/autocomplete'
import { linter, lintGutter, lintKeymap, type Diagnostic } from '@codemirror/lint'
import { LanguageSupport, syntaxHighlighting, bracketMatching, indentOnInput, indentUnit, foldGutter, foldKeymap } from '@codemirror/language'
import { useDatabaseEditorPreferences } from '../../state/databaseEditorPreferences'
import { guardedSqlKeywordCompletion, readySqlCompletion } from './sqlKeywordCompletion'
import type { SQLNamespace } from '@codemirror/lang-sql'
import { scopedSchemaCompletion } from './sqlScopeCompletion'
import { sqlDataTypeCompletion } from './sqlWriteCompletion'
import { sqlSignatureTooltip } from './sqlSignatureTooltip'
import { sqlEditorTheme } from './sqlEditorTheme'
import { dialectFor } from './sqlDialect'
export { dialectFor } from './sqlDialect'
import { catioTheme, catioHighlight } from '../editor/editorTheme'
import { Icon } from '../Icon'
import { editorStats, type EditorStats } from './editorStats'
import { sqlExecutionTarget, type SqlTargetResult } from './sqlExecutionTarget'
import { sqlSearchPhrases } from './sqlSearchPhrases'
import { MetadataNodeActions,type MetadataAction } from '../workbench/MetadataNodeActions'

export interface SqlEditorProps {
  contextActions?:MetadataAction[]
  contextKey?:string
  code: string
  onChange: (value: string) => void
  minHeight?: number
  target?: string
  /** Nested completion data in lang-sql's `SQLNamespace` shape (schemas →
   * tables → columns). The nesting lets lang-sql assign distinct completion
   * types/icons to schemas, tables, and columns. */
  schema?: SQLNamespace
  /** Actual engine/profile for parsing; not the query transport family. */
  engine?: string
  /** Resolve unqualified table names in this namespace. */
  defaultSchema?: string
  /** Invoked on Alt+Enter (the "run query" shortcut). */
  onRun?: () => void
  onRunAll?: () => void
  onTargetChange?: (result: SqlTargetResult) => void
  /** Run just the currently-selected SQL (from the selection toolbar or Alt+Enter with a selection). */
  onRunSelection?: (sql: string) => void
  /** Selection availability only; the caller reads live text at dispatch time. */
  onSelectionChange?: (hasSelection: boolean) => void
  /** 空文档占位提示(mongo/es 控制台展示各自语法示例)。 */
  placeholder?: string
  /** true → 非 SQL 模式:不挂 lang-sql(无 SQL 补全),用于 mongo/es 控制台。 */
  plain?: boolean
  /** plain 模式下的自定义补全源(如 mongo shell 补全)。非 plain 时忽略。 */
  completion?: CompletionSource
  /** plain 模式下的语法诊断源(如 redis 命令诊断)。非 plain 时忽略。 */
  lintSource?: (view: EditorView) => Diagnostic[]
  /**
   * 非 plain(SQL)模式下,在 lang-sql 内置补全之外追加的补全源(如函数签名补全、
   * 外键 JOIN 建议)。与内置补全合并显示,不替换它(保留现有表/列补全不退化)。
   */
  extraCompletion?: CompletionSource
}

/** Imperative handle exposed to parents (e.g. SqlConsole) for cursor-aware
 * insertion of snippet / history / AI text into the live CodeMirror doc. */
export interface SqlEditorHandle {
  /**
   * Insert `text` into the live document and return the resulting full text.
   * - `newLine` falsy (history「插入编辑器」/ AI insert): insert at the caret,
   *   replacing any selection, in place — respects the user's cursor/scroll.
   * - `newLine` true (history「执行」/ snippet run): append at the END of the doc
   *   on its own fresh line (prefixing '\n' when the doc isn't empty and doesn't
   *   already end in one), so a run is never concatenated onto the caret line.
   * Moves the caret to the end of the inserted text and focuses the editor.
   */
  insertAtCursor: (text: string, newLine?: boolean) => string
  /**
   * Return the currently-selected text (trimmed-non-empty selection), or '' when
   * nothing is selected. Lets the parent give selection priority to actions like
   * EXPLAIN — run just the highlighted statement, matching the run() path.
   */
  getSelectedText: () => string
  getExecutionTarget: (scope: 'current'|'selection'|'all') => SqlTargetResult
  selectRange: (from: number, to: number) => void
  openSearch: () => void
}

export const SqlEditor = forwardRef<SqlEditorHandle, SqlEditorProps>(function SqlEditor(
  { contextActions,contextKey,code, onChange, minHeight, target = 'SQL', schema, engine, defaultSchema, onRun, onRunAll, onTargetChange, onRunSelection, onSelectionChange, placeholder, plain, completion, lintSource, extraCompletion },
  ref,
) {
  const { t: tr } = useTranslation()
  const hostRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const sqlCompartment = useRef(new Compartment())
  const searchUiCompartment = useRef(new Compartment())
  const preferencesCompartment = useRef(new Compartment())
  const preferences = useDatabaseEditorPreferences()
  function preferencesExt(): Extension {
    if (plain) return keymap.of(completionKeymap.filter(binding => binding.key === 'Ctrl-Space'))
    return [
      EditorState.tabSize.of(preferences.tabWidth), indentUnit.of(' '.repeat(preferences.tabWidth)),
      ...(preferences.lineWrapping ? [EditorView.lineWrapping] : []),
      ...(preferences.foldGutter ? [foldGutter(), keymap.of(foldKeymap)] : []),
      Prec.high(keymap.of([{ key: preferences.completionKey, run: view => !imeKey.current && !view.composing && !view.compositionStarted && startCompletion(view) }])),
    ]
  }
  // Build the language/completion extension for the SQL compartment. Plain mode
  // (mongo/es) drops lang-sql; it gets a custom completion source when provided.
  function langExt(): Extension {
    if (plain) {
      const exts: Extension[] = []
      if (completion) exts.push(autocompletion({ override: [completion] }))
      // Inline syntax diagnostics (e.g. redis arity/unknown/blocked) + gutter marks.
      if (lintSource) exts.push(linter(view => lintSource(view)), lintGutter())
      return exts
    }
    const dialect = dialectFor(engine)
    const exts: Extension[] = [Prec.high(sqlEditorTheme),new LanguageSupport(dialect.language,
      dialect.language.data.of({autocomplete:guardedSqlKeywordCompletion(dialect)})), autocompletion({ activateOnTyping: preferences.completionOnTyping }),
      EditorView.theme({
        '.cm-tooltip-autocomplete, .cm-tooltip-autocomplete > ul': { maxWidth: 'min(680px, calc(100vw - 32px))' },
        '.cm-tooltip-autocomplete > ul > li': { whiteSpace: 'normal', overflowWrap: 'anywhere' },
      }),
      ...(preferences.signatureHelp ? [sqlSignatureTooltip(engine, tr('dbviews.functionParameters'), tr('dbviews.functionSignatureHint'))] : [])]
    exts.push(dialect.language.data.of({ autocomplete: readySqlCompletion(sqlDataTypeCompletion(engine)) }))
    // lang-sql's schema source is not suppressed in comments/literals on explicit invocation.
    // Wrap it ourselves while retaining its alias and quoted-identifier support.
    if (schema) exts.push(dialect.language.data.of({ autocomplete: readySqlCompletion(
      scopedSchemaCompletion(schema, defaultSchema, engine),
    ) }))
    // 追加的 SQL 补全源(函数签名补全 / 外键 JOIN 建议)。通过 languageData 注册,
    // 与 lang-sql 内置的表/列/关键字补全合并显示(不 override,故现有补全不退化)。
    if (extraCompletion) exts.push(dialect.language.data.of({ autocomplete: readySqlCompletion(
      extraCompletion,
    ) }))
    // SQL problems belong at their exact text range, not in a permanently
    // reserved icon column. Standard lint keys also expose repairs without hover.
    if (lintSource) exts.push(linter(view => lintSource(view),{needsRefresh:update=>update.selectionSet}), keymap.of(lintKeymap),
      EditorState.phrases.of({Diagnostics:tr('dbviews.sqlDiagnostics.panelTitle'),'No diagnostics':tr('dbviews.sqlDiagnostics.noIssues')}))
    return exts
  }
  // Keep the latest callbacks without re-running the mount effect.
  const imeKey = useRef(false)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onRunRef = useRef(onRun)
  onRunRef.current = onRun
  const onRunAllRef=useRef(onRunAll);onRunAllRef.current=onRunAll
  const targetChangeRef=useRef(onTargetChange);targetChangeRef.current=onTargetChange
  const plainRef=useRef(plain);plainRef.current=plain
  const onRunSelectionRef = useRef(onRunSelection)
  onRunSelectionRef.current = onRunSelection
  const selectionChangeRef = useRef(onSelectionChange)
  selectionChangeRef.current = onSelectionChange
  const [selBar, setSelBar] = useState<{ left: number; top: number; text: string; below: boolean } | null>(null)
  const [stats, setStats] = useState<EditorStats>(() => editorStats(code, 0))

  // Mount once.
  useEffect(() => {
    if (!hostRef.current) return
    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      history(),search({top:true}),searchUiCompartment.current.of(sqlSearchPhrases(tr)),
      EditorView.theme({'.cm-panels':{backgroundColor:'var(--surface-subtle)',color:'var(--text-primary)'},'.cm-search input':{backgroundColor:'var(--surface-card)',color:'var(--text-primary)',border:'1px solid var(--border-hairline)',borderRadius:'5px'},'.cm-search button':{backgroundImage:'none',backgroundColor:'var(--surface-sunken)',color:'var(--text-primary)',border:'1px solid var(--border-hairline)',borderRadius:'5px'}}),
      bracketMatching(),
      closeBrackets(),
      indentOnInput(),
      syntaxHighlighting(catioHighlight),
      catioTheme,
      ...(placeholder ? [cmPlaceholder(placeholder)] : []),
      // Observe without consuming the event: native IME candidate confirmation must keep working.
      Prec.highest(EditorView.domEventHandlers({ keydown: event => {
        imeKey.current = event.isComposing || event.keyCode === 229
        return false
      } })),
      keymap.of([
        {
          key: 'Alt-Enter',
          run: view => {
            if (imeKey.current || view.composing || view.compositionStarted) return false
            const sel = view.state.selection.main
            if (!sel.empty && onRunSelectionRef.current) {
              const text = view.state.sliceDoc(sel.from, sel.to).trim()
              if (text) {
                onRunSelectionRef.current(text)
                setSelBar(null)
                return true
              }
              return true // An explicitly empty/whitespace selection must not widen scope.
            }
            onRunRef.current?.()
            setSelBar(null)
            return true
          },
        },
        { key:'Alt-Shift-Enter', run:view=>{if(imeKey.current||view.composing||view.compositionStarted)return false;onRunAllRef.current?.();return true} },
        { key: 'Tab', run: view => !imeKey.current && !view.composing && !view.compositionStarted && acceptCompletion(view) },
        ...closeBracketsKeymap,
        ...completionKeymap.filter(binding => binding.key !== 'Ctrl-Space'),
        ...historyKeymap,
        ...searchKeymap,...defaultKeymap,
        indentWithTab,
      ]),
      preferencesCompartment.current.of(preferencesExt()),
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
          const selection = s.selection.main
          selectionChangeRef.current?.(!selection.empty && !!s.sliceDoc(selection.from, selection.to).trim())
          targetChangeRef.current?.(sqlExecutionTarget(s,selection.empty?'current':'selection',!!plainRef.current))
          setStats(editorStats(s.doc.toString(), s.selection.main.head))
        }
      }),
    ]
    const view = new EditorView({
      state: EditorState.create({ doc: code, extensions }),
      parent: hostRef.current,
    })
    viewRef.current = view
    targetChangeRef.current?.(sqlExecutionTarget(view.state,'current',!!plainRef.current))
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
      selectionChangeRef.current?.(false)
      targetChangeRef.current?.({target:null,reason:'notReady'})
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
  }, [schema, engine, defaultSchema, plain, completion, lintSource, extraCompletion, tr, preferences.completionOnTyping, preferences.signatureHelp])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: preferencesCompartment.current.reconfigure(preferencesExt()) })
  }, [preferences, plain])

  useEffect(()=>{
    const view=viewRef.current;if(!view)return
    const wasOpen=searchPanelOpen(view.state)
    if(wasOpen)closeSearchPanel(view)
    view.dispatch({effects:searchUiCompartment.current.reconfigure(sqlSearchPhrases(tr))})
    if(wasOpen)openSearchPanel(view)
  },[tr])

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
      if (newLine) {
        // "Run" path (history「执行」/ snippet run): the SQL must land on its OWN
        // fresh line, never concatenated onto whatever the caret happens to sit on
        // (which produced `…ordersSELECT …` and a syntax error). Append at the END
        // of the document, prefixing a newline when the doc isn't empty and doesn't
        // already end in one. Caret is left after the inserted text. This is robust
        // regardless of where (or whether) the caret was placed.
        const docLen = view.state.doc.length
        const endsWithNl = docLen > 0 && view.state.doc.sliceString(docLen - 1) === '\n'
        const insert = (docLen > 0 && !endsWithNl ? '\n' : '') + text
        view.dispatch({
          changes: { from: docLen, insert },
          selection: { anchor: docLen + insert.length },
        })
        const next = view.state.doc.toString()
        onChangeRef.current(next)
        try { view.focus() } catch { /* best-effort */ }
        return next
      }
      // Insert-at-cursor path (history「插入编辑器」/ AI insert): replaceSelection
      // inserts at the caret (or replaces the active selection) in place and leaves
      // the caret at the end of the inserted text.
      view.dispatch(view.state.replaceSelection(text))
      const next = view.state.doc.toString()
      // Keep React `code` in sync (the updateListener also fires, but return the
      // fresh doc so the caller can run it synchronously).
      onChangeRef.current(next)
      try { view.focus() } catch { /* best-effort */ }
      return next
    },
    openSearch(){const view=viewRef.current;if(view)openSearchPanel(view)},
    getExecutionTarget(scope) {
      const view=viewRef.current
      return view?sqlExecutionTarget(view.state,scope,!!plainRef.current):{target:null,reason:'notReady'}
    },
    selectRange(from,to) {
      const view=viewRef.current
      if(!view||from<0||to<from||to>view.state.doc.length)return
      view.dispatch({selection:{anchor:from,head:to},scrollIntoView:true});view.focus()
    },
    getSelectedText() {
      const view = viewRef.current
      if (!view) return ''
      const sel = view.state.selection.main
      if (sel.empty) return ''
      const text = view.state.sliceDoc(sel.from, sel.to)
      return text.trim() ? text : ''
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
    <MetadataNodeActions items={contextActions??[]} showTrigger={false} ownerKey={contextKey??target} title={tr('dbviews.moreActions')} style={{height:'100%',minHeight:0}}><div ref={rootRef} className="col" style={{ position: 'relative', background: 'var(--surface-subtle)', minHeight: minHeight || 0, height: '100%', width: '100%', overflow: 'hidden' }}>
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
    </div></MetadataNodeActions>
  )
})
