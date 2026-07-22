/* ported from ref-ui/_extract/blob9.txt — controlled per-tab conversation view (P2) */
import React, { useState, useRef, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
import { Icon } from '../Icon'
import { IconBtn } from '../atoms'
import { highlightSQL } from '../dbviews'
import { useAgentConfig } from '../../state/agentConfig'
import { getSchema, tableStructure } from '../../services/db'
import { buildTableContext } from '../dbviews/tableContext'
import { classifyAiSqlExecution } from '../../services/aiSqlExecutionPolicy'
import type { Connection } from '../../services/types'
import type { Conversation } from '../../state/conversations'
import { PanelShell } from './PanelShell'
import { ConfirmModal } from '../modals/ConfirmModal'

export interface Attachment {
  kind: 'sql' | 'shell'
  target: string
  text: string
}

export interface AIPanelProps {
  onClose: () => void
  mode?: 'sql' | 'shell'
  conn?: Connection
  /** Backend connId for the active DB tab — enables the SQL-mode "@ 选表" picker
   *  (fetches the table list via getSchema and per-table DDL via tableStructure). */
  connId?: string
  /** Engine/DbType of the active connection — selects how the injected table
   *  context is rendered (relational CREATE TABLE vs mongo/es field lists). */
  engine?: string
  attachment: Attachment | null
  onClearAttachment: () => void
  onInsert?: (code: string) => void
  canInsert?: boolean
  onOpenSettings?: () => void
  /** The active tab's current conversation (controlled by App). */
  conversation?: Conversation
  /** True while a send is streaming for the active conversation. */
  busy?: boolean
  /** Past conversations for the active tab's host (newest first). */
  history?: Conversation[]
  /** Send a user message in the current conversation. `hasSelection` is true when
   * the message carries user-selected text (attachment), so the agent can skip
   * injecting the terminal buffer tail — the user already pointed at the context. */
  onSend?: (text: string, opts?: { hasSelection?: boolean }) => void
  /** Abort the in-flight streaming response (wired by App). */
  onAbort?: () => void
  /** Start a fresh conversation for the active tab's host. */
  onNewConversation?: () => void
  /** Restore a past conversation by id. */
  onRestoreConversation?: (convId: string) => void
  /** Delete a past conversation by id. */
  onDeleteConversation?: (convId: string) => void
}

function shellHL(code: string): string {
  let h = code.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  h = h.replace(/('[^']*')/g, '<span style="color:var(--signal-green)">$1</span>')
  h = h.replace(/\b(\d[\d.]*)\b/g, '<span style="color:var(--signal-amber)">$1</span>')
  return h
}

const SQL_LANGS = new Set(['sql', 'mysql', 'postgres', 'postgresql', 'pgsql'])

// ---- Shared copy button hook ----
function useCopied() {
  const [copied, setCopied] = useState(false)
  function copy(text: string) {
    if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }
  return { copied, copy }
}

// ---- Block code card with action row ----
interface BlockCodeProps {
  lang: string
  code: string
  mode: 'sql' | 'shell'
  /** Active DB connection — drives the AI-SQL risk classification before run. */
  conn?: Connection
  onInsert?: (code: string) => void
  canInsert?: boolean
}

// run 前的风险弹窗:confirm 需用户点「确认执行」才派发;block 仅展示阻断说明。
type RunGate = { kind: 'confirm' | 'block'; message: string } | null

function BlockCode({ lang, code, mode, conn, onInsert }: BlockCodeProps) {
  const { t } = useTranslation()
  const { copied, copy } = useCopied()
  const [gate, setGate] = useState<RunGate>(null)
  // In database mode every assistant code block is a runnable DB block (mongo
  // shell / ES REST / SQL) — insert/run target the query editor, not a terminal.
  const isSqlBlock = mode === 'sql' || SQL_LANGS.has(lang)
  const tone = isSqlBlock ? 'var(--signal-blue)' : 'var(--signal-amber)'

  // Insert / run dispatch via window CustomEvents (terminal pane / SQL console listen).
  function doInsert() {
    onInsert?.(code)
    window.dispatchEvent(new CustomEvent('catio-insert', { detail: { kind: mode, text: code } }))
  }
  function dispatchRun() {
    window.dispatchEvent(new CustomEvent('catio-run', { detail: { kind: mode, text: code } }))
  }
  // SQL 块先经风险分级:read → 直接执行;write/schema_change/unknown → 确认弹窗;
  // dangerous → 阻断。非 SQL(shell / mongo / es)沿用直通执行,不改变既有行为。
  function doRun() {
    if (!isSqlBlock || mode !== 'sql') { dispatchRun(); return }
    const decision = classifyAiSqlExecution(code, conn)
    if (decision.action === 'auto_execute') { dispatchRun(); return }
    const prodNote = decision.environment === 'production' ? ' ' + t('panels.aiRunConfirmProd') : ''
    if (decision.action === 'block') {
      setGate({ kind: 'block', message: t('panels.aiRunBlockBody') })
      return
    }
    const base =
      decision.category === 'schema_change' ? t('panels.aiRunConfirmSchema')
        : decision.category === 'unknown' ? t('panels.aiRunConfirmUnknown')
          : t('panels.aiRunConfirmWrite')
    setGate({ kind: 'confirm', message: base + prodNote })
  }

  return (
    <div className="col" style={{ border: '1px solid var(--border-hairline)', borderRadius: 12, overflow: 'hidden', background: 'var(--surface-card)' }}>
      <div className="row gap6" style={{ padding: '6px 8px 6px 10px', background: 'var(--surface-subtle)', borderBottom: '1px solid var(--border-hairline)' }}>
        <span className="dot" style={{ background: tone }} />
        <Icon name={isSqlBlock ? 'database' : 'terminal'} size={12} style={{ color: tone }} />
        <span className="mono" style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-secondary)' }}>{isSqlBlock ? 'SQL' : 'SHELL'}</span>
        <div className="grow" />
        {/* mode-specific actions: copy · insert · run */}
        <button className="icon-btn bare" style={{ width: 24, height: 24 }} title={copied ? t('panels.copied') : t('panels.copy')} onClick={() => copy(code)}>
          <Icon name={copied ? 'check' : 'copy'} size={13} style={copied ? { color: 'var(--signal-green)' } : undefined} />
        </button>
        <button className="icon-btn bare" style={{ width: 24, height: 24 }} title={mode === 'shell' ? t('panels.insertTerminal') : t('panels.insertEditor')} onClick={doInsert}>
          <Icon name={mode === 'shell' ? 'terminal' : 'arrow-right-to-line'} size={14} />
        </button>
        <button className="icon-btn bare" style={{ width: 24, height: 24 }} title={mode === 'shell' ? t('panels.runCommand') : t('panels.execSql')} onClick={doRun}>
          <Icon name="play" size={13} />
        </button>
      </div>
      <pre className="mono" style={{ margin: 0, padding: '9px 10px', fontSize: 11.5, lineHeight: 1.55, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', background: 'var(--surface-subtle)', overflowX: 'auto' }}
        dangerouslySetInnerHTML={{ __html: isSqlBlock ? highlightSQL(code) : shellHL(code) }} />
      {gate && (
        <ConfirmModal
          danger
          title={gate.kind === 'block' ? t('panels.aiRunBlockTitle') : t('panels.aiRunConfirmTitle')}
          message={gate.message}
          // block 仅是确认知晓,没有「确认执行」按钮;confirm 才真正派发 run。
          confirmLabel={gate.kind === 'block' ? t('panels.aiRunBlockOk') : t('panels.aiRunConfirmBtn')}
          cancelLabel={t('panels.cancel')}
          onCancel={() => setGate(null)}
          onConfirm={() => {
            const kind = gate.kind
            setGate(null)
            if (kind === 'confirm') dispatchRun()
          }}
        />
      )}
    </div>
  )
}

// ---- Build react-markdown components with closure over mode/onInsert/canInsert ----
function makeComponents(mode: 'sql' | 'shell', conn?: Connection, onInsert?: (code: string) => void, canInsert?: boolean): Components {
  return {
    // ---- code: inline vs block detection ----
    // In react-markdown v10 there is no `inline` prop. Block code has className like "language-sh".
    // Inline code has no className. We also treat code with a newline as block.
    code({ className, children, ...rest }) {
      const lang = (className ?? '').replace('language-', '')
      const isBlock = !!className || String(children).includes('\n')
      if (!isBlock) {
        // Inline code
        return (
          <code
            {...rest}
            style={{
              fontFamily: 'var(--font-mono, monospace)',
              fontSize: '12px',
              background: 'var(--surface-sunken)',
              color: 'var(--text-primary)',
              padding: '1px 5px',
              borderRadius: 4,
              border: '1px solid var(--border-hairline)',
            }}
          >
            {children}
          </code>
        )
      }
      const code = String(children).replace(/\n$/, '')
      return <BlockCode lang={lang} code={code} mode={mode} conn={conn} onInsert={onInsert} canInsert={canInsert} />
    },
    // pre: let the code component handle block rendering; pre itself just renders children
    pre({ children }) {
      return <>{children}</>
    },
    // ---- Headings — sized down to fit 13px panel body ----
    h1({ children }) {
      return <h1 style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', margin: '10px 0 4px', lineHeight: 1.3 }}>{children}</h1>
    },
    h2({ children }) {
      return <h2 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', margin: '8px 0 4px', lineHeight: 1.3 }}>{children}</h2>
    },
    h3({ children }) {
      return <h3 style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', margin: '6px 0 3px', lineHeight: 1.3 }}>{children}</h3>
    },
    h4({ children }) {
      return <h4 style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', margin: '4px 0 2px', lineHeight: 1.3 }}>{children}</h4>
    },
    // ---- Paragraph ----
    p({ children }) {
      return <p style={{ margin: '6px 0', lineHeight: 1.55, color: 'var(--text-secondary)', fontSize: 13 }}>{children}</p>
    },
    // ---- Lists ----
    ul({ children }) {
      return <ul style={{ margin: '4px 0', paddingLeft: 18, listStyleType: 'disc' }}>{children}</ul>
    },
    ol({ children }) {
      return <ol style={{ margin: '4px 0', paddingLeft: 18, listStyleType: 'decimal' }}>{children}</ol>
    },
    li({ children }) {
      return <li style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--text-secondary)', marginBottom: 2 }}>{children}</li>
    },
    // ---- Strong / em ----
    strong({ children }) {
      return <strong style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{children}</strong>
    },
    em({ children }) {
      return <em style={{ fontStyle: 'italic', color: 'var(--text-secondary)' }}>{children}</em>
    },
    // ---- Links — prevent Tauri webview navigation ----
    a({ href, children }) {
      function handleClick(e: React.MouseEvent<HTMLAnchorElement>) {
        e.preventDefault()
        if (href) window.open(href, '_blank', 'noreferrer')
      }
      return (
        <a href={href} onClick={handleClick} rel="noreferrer"
          style={{ color: 'var(--accent-primary)', textDecoration: 'underline', cursor: 'pointer' }}>
          {children}
        </a>
      )
    },
    // ---- Tables (GFM) ----
    table({ children }) {
      return (
        <div style={{ overflowX: 'auto', margin: '6px 0' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%', color: 'var(--text-secondary)' }}>{children}</table>
        </div>
      )
    },
    th({ children }) {
      return (
        <th style={{ border: '1px solid var(--border-hairline)', padding: '4px 8px', fontWeight: 700, color: 'var(--text-primary)', background: 'var(--surface-subtle)', textAlign: 'left' }}>
          {children}
        </th>
      )
    },
    td({ children }) {
      return <td style={{ border: '1px solid var(--border-hairline)', padding: '4px 8px' }}>{children}</td>
    },
    // ---- Blockquote ----
    blockquote({ children }) {
      return (
        <blockquote style={{ borderLeft: '3px solid var(--border-hairline)', margin: '6px 0', paddingLeft: 10, color: 'var(--text-tertiary)', fontStyle: 'italic' }}>
          {children}
        </blockquote>
      )
    },
    // ---- HR ----
    hr() {
      return <hr style={{ border: 'none', borderTop: '1px solid var(--border-hairline)', margin: '8px 0' }} />
    },
  }
}

interface AssistantMessageProps {
  text: string
  mode: 'sql' | 'shell'
  conn?: Connection
  onInsert?: (code: string) => void
  canInsert?: boolean
}

function AssistantMessage({ text, mode, conn, onInsert, canInsert }: AssistantMessageProps) {
  // Memoize components so react-markdown doesn't remount its subtree on every token update.
  // onInsert and canInsert are stable per conversation turn, so this is safe.
  const components = useMemo(
    () => makeComponents(mode, conn, onInsert, canInsert),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, conn, onInsert, canInsert],
  )
  return (
    <div className="col gap4" style={{ maxWidth: '94%' }}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
}

// ---- Relative-time formatter for the history dropdown ----
function useRelativeTime() {
  const { t } = useTranslation()
  return (ts: number): string => {
    const diff = Date.now() - ts
    const min = Math.floor(diff / 60000)
    if (min < 1) return t('panels.relJustNow')
    if (min < 60) return t('panels.relMinutesAgo', { count: min })
    const hr = Math.floor(min / 60)
    if (hr < 24) return t('panels.relHoursAgo', { count: hr })
    const day = Math.floor(hr / 24)
    return t('panels.relDaysAgo', { count: day })
  }
}

interface HistoryDropdownProps {
  history: Conversation[]
  currentId?: string
  onRestore?: (id: string) => void
  onDelete?: (id: string) => void
  onClose: () => void
}

function HistoryDropdown({ history, currentId, onRestore, onDelete, onClose }: HistoryDropdownProps) {
  const { t } = useTranslation()
  const rel = useRelativeTime()
  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={onClose} />
      <div className="pop-in" style={{ position: 'absolute', top: 28, right: 0, zIndex: 50, width: 248, background: 'var(--surface-elevated)', border: '1px solid var(--border-hairline-alt)', borderRadius: 10, boxShadow: 'var(--shadow-dropdown)', padding: 5, maxHeight: 320, overflowY: 'auto' }}>
        {history.length === 0 ? (
          <div className="col" style={{ alignItems: 'center', justifyContent: 'center', padding: '22px 0', gap: 6, color: 'var(--text-faint)' }}>
            <Icon name="history" size={20} />
            <span style={{ fontSize: 12 }}>{t('panels.noConversations')}</span>
          </div>
        ) : history.map(c => {
          const active = c.id === currentId
          return (
            <div key={c.id} className="row gap6" style={{ width: '100%', padding: '7px 8px', borderRadius: 8, background: active ? 'var(--accent-soft)' : 'transparent' }}
              onMouseEnter={e => { if (!active) (e.currentTarget as HTMLDivElement).style.background = 'var(--surface-sunken)' }}
              onMouseLeave={e => { if (!active) (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}>
              <button className="col" style={{ flex: 1, minWidth: 0, alignItems: 'flex-start', textAlign: 'left', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}
                onClick={() => { onRestore?.(c.id); onClose() }}>
                <span className="ell" style={{ fontSize: 12.5, fontWeight: active ? 600 : 500, color: active ? 'var(--accent-primary)' : 'var(--text-secondary)', maxWidth: 180 }}>{c.title || t('panels.untitledConversation')}</span>
                <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{rel(c.updatedAt)}</span>
              </button>
              <button className="icon-btn bare" style={{ width: 22, height: 22, flex: 'none' }} title={t('panels.deleteConversation')}
                onClick={e => { e.stopPropagation(); onDelete?.(c.id) }}>
                <Icon name="trash-2" size={13} />
              </button>
            </div>
          )
        })}
      </div>
    </>
  )
}

interface MentionTable {
  schema: string
  name: string
  kind: 'table' | 'view'
}

export function AIPanel({ onClose, mode = 'sql', conn, connId, engine, attachment, onClearAttachment, onInsert, canInsert, onOpenSettings, conversation, busy = false, history = [], onSend, onAbort, onNewConversation, onRestoreConversation, onDeleteConversation }: AIPanelProps) {
  const { t } = useTranslation()
  const { config: cfg, update: updateAgentConfig } = useAgentConfig()
  const isSql = mode !== 'shell'
  // Strictly follows the active workbench tab — no mock fallback. When there is
  // no active host/db tab, the panel shows a connect-first empty state instead.
  const hasTarget = !!conn
  const target = conn?.name ?? ''
  const accent = isSql ? 'var(--signal-blue)' : 'var(--signal-amber)'
  const executionOptions = [
    { value: 'manual' as const, label: t('panels.agentExecutionManual'), hint: t('panels.agentExecutionManualHint') },
    { value: 'ask' as const, label: t('panels.agentExecutionAsk'), hint: t('panels.agentExecutionAskHint') },
    { value: 'auto' as const, label: t('panels.agentExecutionAuto'), hint: t('panels.agentExecutionAutoHint') },
  ]
  const selectedExecution = executionOptions.find(option => option.value === cfg.executionMode) ?? executionOptions[0]
  const [draft, setDraft] = useState('')
  const [histOpen, setHistOpen] = useState(false)
  const [executionMenuOpen, setExecutionMenuOpen] = useState(false)
  const [executionMenuPosition, setExecutionMenuPosition] = useState<{ left: number; top?: number; bottom?: number; maxHeight: number } | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const executionTriggerRef = useRef<HTMLButtonElement>(null)
  const executionMenuRef = useRef<HTMLDivElement>(null)
  // "@ 选表" state — only meaningful in SQL mode with a live connId.
  const [tableList, setTableList] = useState<MentionTable[]>([])
  const [selectedTables, setSelectedTables] = useState<{ schema: string; table: string; kind: 'table' | 'view' }[]>([])
  // null = mention dropdown closed; otherwise the current filter text after '@'.
  const [mentionFilter, setMentionFilter] = useState<string | null>(null)

  const msgs = conversation?.messages ?? []

  useEffect(() => { if (attachment && taRef.current) taRef.current.focus() }, [attachment])
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight }, [msgs])

  function positionExecutionMenu() {
    const trigger = executionTriggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const width = 276
    const gap = 6
    const viewportPadding = 8
    const left = Math.max(viewportPadding, Math.min(rect.right - width, window.innerWidth - width - viewportPadding))
    const spaceAbove = rect.top - viewportPadding - gap
    const spaceBelow = window.innerHeight - rect.bottom - viewportPadding - gap
    if (spaceAbove >= spaceBelow) {
      setExecutionMenuPosition({ left, bottom: window.innerHeight - rect.top + gap, maxHeight: Math.max(180, spaceAbove) })
    } else {
      setExecutionMenuPosition({ left, top: rect.bottom + gap, maxHeight: Math.max(180, spaceBelow) })
    }
  }

  function handleExecutionMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'))
    const current = options.indexOf(document.activeElement as HTMLButtonElement)
    let next = current
    if (event.key === 'ArrowDown') next = current < 0 ? 0 : Math.min(options.length - 1, current + 1)
    else if (event.key === 'ArrowUp') next = current < 0 ? options.length - 1 : Math.max(0, current - 1)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = options.length - 1
    else if (event.key === 'Enter' || event.key === ' ') {
      if (current >= 0) {
        event.preventDefault()
        options[current].click()
      }
      return
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setExecutionMenuOpen(false)
      executionTriggerRef.current?.focus()
      return
    } else return
    event.preventDefault()
    options[next]?.focus()
  }

  useEffect(() => {
    if (!executionMenuOpen) return
    const selected = executionMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]')
    ;(selected ?? executionMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]'))?.focus()
    const closeOutside = (event: MouseEvent) => {
      const target = event.target as Node
      if (!executionTriggerRef.current?.contains(target) && !executionMenuRef.current?.contains(target)) setExecutionMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        setExecutionMenuOpen(false)
        executionTriggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    window.addEventListener('resize', positionExecutionMenu)
    window.addEventListener('scroll', positionExecutionMenu, true)
    return () => {
      document.removeEventListener('mousedown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
      window.removeEventListener('resize', positionExecutionMenu)
      window.removeEventListener('scroll', positionExecutionMenu, true)
    }
  }, [executionMenuOpen])

  // Fetch the table/view list for the @ picker when the SQL-mode connection changes.
  useEffect(() => {
    if (!isSql || !connId) { setTableList([]); return }
    let alive = true
    getSchema(connId)
      .then(s => {
        if (!alive) return
        const list: MentionTable[] = []
        for (const ns of s.schemas) {
          for (const tbl of ns.tables) list.push({ schema: ns.name, name: tbl.name, kind: 'table' })
          for (const v of ns.views) list.push({ schema: ns.name, name: v.name, kind: 'view' })
        }
        setTableList(list)
      })
      .catch(() => { if (alive) setTableList([]) })
    return () => { alive = false }
  }, [isSql, connId])

  // Reset @ state when leaving SQL mode or switching connection.
  useEffect(() => { setSelectedTables([]); setMentionFilter(null) }, [isSql, connId])

  // Tables matching the current '@' filter (case-insensitive, name or schema).
  const mentionMatches = useMemo(() => {
    if (mentionFilter == null) return []
    const f = mentionFilter.toLowerCase()
    return tableList.filter(t => t.name.toLowerCase().includes(f) || t.schema.toLowerCase().includes(f))
  }, [mentionFilter, tableList])

  // Detect an in-progress '@token' at the caret (end of draft) and open the picker.
  function onDraftChange(value: string) {
    setDraft(value)
    if (!isSql || !connId) { setMentionFilter(null); return }
    const m = /(^|\s)@(\S*)$/.exec(value)
    setMentionFilter(m ? m[2] : null)
  }

  // Pick a table from the dropdown: add a chip and strip the '@token' from the draft.
  function pickTable(item: MentionTable) {
    setSelectedTables(prev =>
      prev.some(s => s.schema === item.schema && s.table === item.name)
        ? prev
        : [...prev, { schema: item.schema, table: item.name, kind: item.kind }])
    setDraft(prev => prev.replace(/(^|\s)@(\S*)$/, (_m, lead) => lead))
    setMentionFilter(null)
  }

  async function send() {
    const text = draft.trim()
    if (!text || !cfg.model || busy) return

    let userContent = text
    const hasSelection = !!attachment
    if (attachment) {
      userContent += `\n\n---\n${attachment.text}`
      onClearAttachment()
    }
    // Inject the selected tables' structure as one-time context (best-effort:
    // a failed fetch skips that table rather than blocking the send).
    if (isSql && connId && selectedTables.length > 0) {
      for (const s of selectedTables) {
        try {
          const struct = await tableStructure(connId, s.schema, s.table)
          userContent += `\n\n---\n${buildTableContext(engine, s.schema, s.table, struct)}`
        } catch { /* skip this table */ }
      }
      setSelectedTables([])
    }
    setHistOpen(false)
    onSend?.(userContent, { hasSelection })
    setDraft('')
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <PanelShell icon="wand" title="Catio Agent"
      sub={hasTarget ? (isSql ? t('panels.sqlAssistantSub', { target }) : t('panels.shellAssistantSub', { target })) : t('panels.agentNeedConnSub')}
      onClose={onClose}
      actions={hasTarget
        ? (
          <>
            <IconBtn name="plus" size={15} variant="bare" title={t('panels.newConversation')} disabled={busy} onClick={() => onNewConversation?.()} />
            <div style={{ position: 'relative' }}>
              <IconBtn name="history" size={15} variant="bare" title={t('panels.conversationHistory')} active={histOpen} disabled={busy} onClick={() => setHistOpen(o => !o)} />
              {histOpen && (
                <HistoryDropdown history={history} currentId={conversation?.id} onClose={() => setHistOpen(false)}
                  onRestore={onRestoreConversation} onDelete={onDeleteConversation} />
              )}
            </div>
          </>
        )
        : undefined
      }>
      {/* No active host/db tab → connect-first empty state; hide banner + composer. */}
      {!hasTarget ? (
        <div className="grow col" style={{ alignItems: 'center', justifyContent: 'center', gap: 14, padding: '24px 28px', textAlign: 'center' }}>
          <div className="icon-badge" style={{ width: 48, height: 48, borderRadius: 14, background: 'var(--surface-sunken)', color: 'var(--text-faint)' }}><Icon name="plug" size={22} /></div>
          <div className="col" style={{ gap: 6 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)' }}>{t('panels.agentNeedConnTitle')}</span>
            <span style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--text-faint)', maxWidth: 280 }}>{t('panels.agentNeedConnHint')}</span>
          </div>
        </div>
      ) : (
        <>
      {/* scope banner — strictly follows the active workbench tab */}
      <div className="row gap8" style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-hairline)' }}>
        <span className="chip" style={{ background: `color-mix(in srgb, ${accent} 15%, transparent)`, color: accent, fontWeight: 600 }}>
          <Icon name={isSql ? 'database' : 'terminal'} size={11} /> {isSql ? t('panels.sqlMode') : t('panels.shellMode')}
        </span>
        <span className="row gap5" style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>
          <Icon name="link" size={11} style={{ color: 'var(--text-faint)' }} />
          <span>{t('panels.followActiveTab', { target })}</span>
        </span>
      </div>
      {/* message area */}
      {!cfg.model ? (
        <div className="grow col" style={{ alignItems: 'center', justifyContent: 'center', gap: 14, padding: '24px 28px', textAlign: 'center' }}>
          <div className="icon-badge" style={{ width: 48, height: 48, borderRadius: 14, background: 'var(--surface-sunken)', color: 'var(--text-faint)' }}><Icon name="box" size={22} /></div>
          <span style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--text-tertiary)' }}>{t('panels.agentNoModel')}</span>
          <button className="btn btn-primary sm" onClick={() => onOpenSettings?.()}><Icon name="settings" size={14} /> {t('panels.agentConfigure')}</button>
        </div>
      ) : (
        <div ref={scrollRef} className="grow" style={{ overflowY: 'auto', padding: '14px 12px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {msgs.map((m, i) => m.role === 'user'
            ? <div key={i} style={{ alignSelf: 'flex-end', maxWidth: '88%', background: 'var(--accent-primary)', color: 'var(--on-accent)', padding: '9px 12px', borderRadius: '14px 14px 4px 14px', fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{m.content}</div>
            : <AssistantMessage key={i} text={m.content} mode={mode} conn={conn} onInsert={onInsert} canInsert={canInsert} />)}
          {busy && msgs.length > 0 && msgs[msgs.length - 1].content === '' && (
            <div className="row gap6" style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>
              <Icon name="loader" size={13} style={{ animation: 'spin 1s linear infinite' }} /> {t('panels.agentThinking')}
            </div>
          )}
        </div>
      )}
      {/* composer */}
      <div style={{ padding: 10, borderTop: '1px solid var(--border-hairline)', position: 'relative' }}>
        {/* @ 选表下拉 — anchored above the composer (SQL mode only). */}
        {isSql && mentionFilter != null && (
          <div className="pop-in" style={{ position: 'absolute', left: 10, right: 10, bottom: '100%', marginBottom: 6, zIndex: 50, background: 'var(--surface-elevated)', border: '1px solid var(--border-hairline-alt)', borderRadius: 10, boxShadow: 'var(--shadow-dropdown)', maxHeight: 220, overflowY: 'auto', padding: 5 }}>
            {mentionMatches.length === 0
              ? <div style={{ padding: '10px 8px', fontSize: 12, color: 'var(--text-faint)' }}>{t('panels.mentionNoTables')}</div>
              : mentionMatches.map((item, i) => (
                <button key={`${item.schema}.${item.name}.${i}`} className="row gap6" style={{ width: '100%', textAlign: 'left', padding: '6px 8px', borderRadius: 7, background: 'transparent', border: 'none', cursor: 'pointer' }}
                  onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--surface-sunken)' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
                  onMouseDown={e => e.preventDefault()} onClick={() => pickTable(item)}>
                  <Icon name={item.kind === 'view' ? 'eye' : 'database'} size={13} style={{ color: 'var(--accent-primary)' }} />
                  <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{item.name}</span>
                  <span className="grow" />
                  <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{item.schema}</span>
                </button>
              ))}
          </div>
        )}
        {/* selected-table chips — one-time DDL context for the next message. */}
        {isSql && selectedTables.length > 0 && (
          <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
            {selectedTables.map((s, i) => (
              <span key={`${s.schema}.${s.table}.${i}`} className="row gap5 chip" style={{ background: 'var(--accent-soft-alt)', color: 'var(--accent-primary)', fontWeight: 600, paddingRight: 4 }}>
                <Icon name={s.kind === 'view' ? 'eye' : 'database'} size={11} />
                {s.table}
                <button className="icon-btn bare" style={{ width: 16, height: 16 }} title={t('panels.removeTable')}
                  onClick={() => setSelectedTables(prev => prev.filter((_, j) => j !== i))}>
                  <Icon name="x" size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        {/* attached terminal/SQL output — piped in via "问 AI" */}
        {attachment && (
          <div className="col pop-in" style={{ border: '1px solid var(--accent-border)', background: 'var(--accent-soft-alt)', borderRadius: 11, padding: '8px 10px', marginBottom: 8 }}>
            <div className="row gap6" style={{ marginBottom: 5 }}>
              <Icon name={attachment.kind === 'sql' ? 'database' : 'terminal'} size={12} style={{ color: 'var(--accent-primary)' }} />
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent-primary)' }}>{t('panels.attachedOutput', { target: attachment.target })}</span>
              <span className="grow" />
              <button className="icon-btn bare" style={{ width: 20, height: 20 }} title={t('panels.removeAttachment')} onClick={onClearAttachment}><Icon name="x" size={12} /></button>
            </div>
            <pre className="mono" style={{ margin: 0, fontSize: 10.8, lineHeight: 1.5, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', maxHeight: 92, overflowY: 'auto', wordBreak: 'break-all' }}>{attachment.text}</pre>
          </div>
        )}
        <div className="col" style={{ background: 'var(--surface-sunken)', border: `1px solid ${attachment ? 'var(--accent-border)' : 'var(--border-hairline)'}`, borderRadius: 12, padding: 8 }}>
          <textarea ref={taRef} value={draft} onChange={e => onDraftChange(e.target.value)} onKeyDown={onKeyDown}
            placeholder={attachment ? t('panels.composerPlaceholderAttached') : (isSql ? t('panels.composerPlaceholderSql') : t('panels.composerPlaceholderShell', { target }))}
            rows={2} style={{ border: 'none', outline: 'none', background: 'transparent', resize: 'none', fontSize: 13, color: 'var(--text-primary)', fontFamily: 'inherit' }} />
          <div className="row" style={{ gap: 8, marginTop: 4 }}>
            <div className="row gap4" style={{ flex: 1, minWidth: 0 }}>
              {!isSql && <div style={{ position: 'relative', flex: 'none' }}>
                <button
                  ref={executionTriggerRef}
                  type="button"
                  className="row gap4"
                  aria-label={t('panels.agentExecutionMode')}
                  aria-haspopup="menu"
                  aria-expanded={executionMenuOpen}
                  aria-controls="agent-execution-menu"
                  title={selectedExecution.hint}
                  onClick={() => {
                    if (executionMenuOpen) setExecutionMenuOpen(false)
                    else {
                      positionExecutionMenu()
                      setExecutionMenuOpen(true)
                    }
                  }}
                  style={{ height: 26, padding: '0 7px', border: `1px solid ${executionMenuOpen ? 'var(--accent-border)' : 'var(--border-hairline)'}`, borderRadius: 8, color: executionMenuOpen ? 'var(--accent-primary)' : 'var(--text-tertiary)', background: executionMenuOpen ? 'var(--accent-soft-alt)' : 'var(--surface-card)', boxShadow: executionMenuOpen ? 'var(--glow-selected)' : 'none' }}
                >
                  <Icon name="shield" size={12} />
                  <span style={{ maxWidth: 66, fontSize: 10.5, fontWeight: 600, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{selectedExecution.label}</span>
                  <Icon name="chevron-down" size={11} style={{ color: 'var(--text-faint)', transform: executionMenuOpen ? 'rotate(180deg)' : 'none', transition: 'transform .14s' }} />
                </button>
                {executionMenuOpen && executionMenuPosition && createPortal(
                  <div ref={executionMenuRef} id="agent-execution-menu" role="menu" aria-label={t('panels.agentExecutionMode')} className="pop-in" onKeyDown={handleExecutionMenuKeyDown} style={{ position: 'fixed', left: executionMenuPosition.left, top: executionMenuPosition.top, bottom: executionMenuPosition.bottom, zIndex: 1000, width: 276, maxHeight: executionMenuPosition.maxHeight, overflowY: 'auto', padding: 6, background: 'var(--surface-elevated)', border: '1px solid var(--border-hairline-alt)', borderRadius: 12, boxShadow: 'var(--shadow-dropdown)' }}>
                    <div style={{ padding: '5px 8px 7px', fontSize: 10.5, fontWeight: 700, color: 'var(--text-faint)', letterSpacing: '.02em' }}>{t('panels.agentExecutionMode')}</div>
                    {executionOptions.map(option => {
                      const active = option.value === cfg.executionMode
                      return (
                        <button
                          key={option.value}
                          type="button"
                          role="menuitemradio"
                          aria-checked={active}
                          tabIndex={active ? 0 : -1}
                          onClick={() => {
                            updateAgentConfig({ executionMode: option.value })
                            setExecutionMenuOpen(false)
                            executionTriggerRef.current?.focus()
                          }}
                          style={{ display: 'grid', gridTemplateColumns: '22px 1fr 16px', width: '100%', alignItems: 'start', gap: 8, padding: '9px 8px', textAlign: 'left', borderRadius: 9, background: active ? 'var(--accent-soft-alt)' : 'transparent' }}
                          onMouseEnter={event => { if (!active) event.currentTarget.style.background = 'var(--surface-sunken)' }}
                          onMouseLeave={event => { if (!active) event.currentTarget.style.background = 'transparent' }}
                        >
                          <span style={{ width: 22, height: 22, display: 'grid', placeItems: 'center', borderRadius: 7, color: active ? 'var(--accent-primary)' : 'var(--text-tertiary)', background: active ? 'var(--accent-soft)' : 'var(--surface-sunken)' }}>
                            <Icon name="shield" size={12} />
                          </span>
                          <span className="col gap2">
                            <span style={{ fontSize: 12, fontWeight: 650, color: active ? 'var(--accent-primary)' : 'var(--text-primary)' }}>{option.label}</span>
                            <span style={{ fontSize: 10.5, lineHeight: 1.45, color: 'var(--text-tertiary)' }}>{option.hint}</span>
                          </span>
                          {active && <Icon name="check" size={13} style={{ marginTop: 3, color: 'var(--accent-primary)' }} />}
                        </button>
                      )
                    })}
                    <div className="row gap6" style={{ margin: '5px 4px 1px', padding: '7px 8px', borderRadius: 8, background: 'var(--surface-sunken)', color: 'var(--text-faint)', alignItems: 'flex-start' }}>
                      <Icon name="info" size={12} style={{ flex: 'none', marginTop: 1 }} />
                      <span style={{ fontSize: 10, lineHeight: 1.45 }}>{t('panels.agentExecutionOutputHint')}</span>
                    </div>
                  </div>,
                  document.body,
                )}
              </div>}
              <button className="icon-btn bare" style={{ width: 26, height: 26, flex: 'none' }} title={t('panels.selectModel')} onClick={() => onOpenSettings?.()}><Icon name="box" size={14} /></button>
              <span className="ell" title={cfg.model || t('panels.modelInfo')} style={{ flex: 1, minWidth: 0, fontSize: 11, color: 'var(--text-faint)', alignSelf: 'center' }}>{cfg.model || t('panels.modelInfo')}</span>
            </div>
            {busy
              ? <button className="btn sm" style={{ width: 32, padding: 0, flex: 'none', background: 'var(--signal-red, #e5484d)', color: '#fff', borderColor: 'var(--signal-red, #e5484d)' }} title={t('panels.stop')} onClick={() => onAbort?.()}><Icon name="square" size={13} /></button>
              : <button className="btn btn-primary sm" style={{ width: 32, padding: 0, flex: 'none' }} title={t('panels.send')} disabled={!cfg.model || !draft.trim()} onClick={() => void send()}><Icon name="send" size={14} /></button>}
          </div>
        </div>
      </div>
        </>
      )}
    </PanelShell>
  )
}
