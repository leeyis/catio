/* ported from ref-ui/_extract/blob5.txt — verbatim per plan T1-T7 */
import React, { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { highlightSQL } from './highlightSQL'

export interface SqlEditorProps {
  code: string
  onChange: (value: string) => void
  minHeight?: number
  target?: string
}

const sqlEditorLayer: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  margin: 0,
  padding: '12px 14px',
  fontSize: 13,
  lineHeight: 1.6,
  fontFamily: "'Geist Mono', monospace",
  whiteSpace: 'pre',
  overflow: 'auto',
  tabSize: 2,
}

export function SqlEditor({ code, onChange, minHeight, target = 'prod-orders' }: SqlEditorProps) {
  const { t } = useTranslation()
  const taRef = useRef<HTMLTextAreaElement>(null)
  const preRef = useRef<HTMLPreElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const [selBar, setSelBar] = useState<{ left: number; top: number; text: string } | null>(null)

  const sync = () => {
    if (preRef.current && taRef.current) {
      preRef.current.scrollTop = taRef.current.scrollTop
      preRef.current.scrollLeft = taRef.current.scrollLeft
    }
    setSelBar(null)
  }
  const lines = code.split('\n').length

  function onSelect(e: React.MouseEvent<HTMLTextAreaElement>) {
    const ta = taRef.current, root = rootRef.current
    if (!ta || !root) return
    if (ta.selectionStart === ta.selectionEnd) { setSelBar(null); return }
    const text = code.slice(ta.selectionStart, ta.selectionEnd)
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
    <div ref={rootRef} style={{ display: 'flex', alignItems: 'stretch', position: 'relative', background: 'var(--surface-subtle)', minHeight: minHeight || 0, height: '100%' }}>
      {/* gutter */}
      <div aria-hidden className="mono" style={{ flex: 'none', width: 44, padding: '12px 8px 12px 0', textAlign: 'right', color: 'var(--text-disabled)', fontSize: 12.5, lineHeight: 1.6, userSelect: 'none', background: 'var(--surface-sunken)', borderRight: '1px solid var(--border-hairline)' }}>
        {Array.from({ length: lines }, (_, i) => <div key={i}>{i + 1}</div>)}
      </div>
      <div className="grow" style={{ position: 'relative', overflow: 'hidden' }}>
        <pre ref={preRef} aria-hidden className="mono" style={sqlEditorLayer} dangerouslySetInnerHTML={{ __html: highlightSQL(code) + '\n' }} />
        <textarea ref={taRef} value={code} onChange={e => onChange(e.target.value)} onScroll={sync} spellCheck={false}
          onMouseUp={onSelect} onMouseDown={() => setSelBar(null)} onKeyDown={() => setSelBar(null)} onBlur={() => setSelBar(null)}
          className="mono" style={{ ...sqlEditorLayer, color: 'transparent', caretColor: 'var(--accent-primary)', resize: 'none', background: 'transparent', outline: 'none', border: 'none' }} />
      </div>
      {/* selection toolbar — copy / ask AI */}
      {selBar && (
        <div className="row gap2 pop-in" style={{ position: 'absolute', left: selBar.left, top: selBar.top - 10, transform: 'translate(-50%, -100%)', zIndex: 30, background: 'var(--surface-elevated)', border: '1px solid var(--border-hairline-alt)', borderRadius: 9, boxShadow: 'var(--shadow-dropdown)', padding: 3 }}>
          <button className="row gap5 sel-pill" onMouseDown={e => e.preventDefault()} onClick={copySel}
            style={{ height: 27, padding: '0 10px', borderRadius: 7, fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
            <Icon name="copy" size={13} /> {t('dbviews.copySel')}
          </button>
          <div style={{ width: 1, background: 'var(--border-hairline)', margin: '3px 1px' }} />
          <button className="row gap5 sel-pill" onMouseDown={e => e.preventDefault()} onClick={askSelAI}
            style={{ height: 27, padding: '0 10px', borderRadius: 7, fontSize: 12, fontWeight: 600, color: 'var(--accent-primary)' }}>
            <Icon name="sparkles" size={13} /> {t('dbviews.askAI')}
          </button>
          <span style={{ position: 'absolute', left: '50%', bottom: -5, transform: 'translateX(-50%) rotate(45deg)', width: 8, height: 8, background: 'var(--surface-elevated)', borderRight: '1px solid var(--border-hairline-alt)', borderBottom: '1px solid var(--border-hairline-alt)' }} />
        </div>
      )}
    </div>
  )
}
